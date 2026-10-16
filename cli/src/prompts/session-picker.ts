import {
  createPrompt,
  useState,
  useKeypress,
  usePrefix,
  usePagination,
  isUpKey,
  isDownKey,
  isSpaceKey,
  isEnterKey,
  makeTheme,
} from "@inquirer/core";
import { styleText } from "node:util";
import figures from "@inquirer/figures";
import { filterAndRank } from "./fuzzy-match.js";
import {
  clampCursor,
  itemAtCursor,
  jumpCursor,
  moveCursor,
  partitionItems,
  type Cursor,
} from "./picker-navigation.js";

export interface PickerChoice {
  name: string;
  description: string;
  /**
   * Short marker for an item that carries restrictions or source metadata.
   * Kept separate from `description` on purpose: the filter below matches name
   * and description, so folding it in would silently change what typing matches.
   */
  hint?: string;
  boundHint?: string;
}

interface Item extends PickerChoice {
  /**
   * Positions in `name` the current filter matched, for highlighting. Absent
   * when there is no filter, or when the row is here on a description match.
   */
  matchIndices?: number[];
}

export interface SessionPickerConfig {
  message?: string;
  boundsMessage?: string;
  emptyMessage?: string;
  pageSize?: number;
  items: PickerChoice[];
  bounds?: PickerChoice[];
  resolveBounds?: (pickedBags: string[]) => PickerChoice[] | Promise<PickerChoice[]>;
  /**
   * Item names to start checked. Used on resume or recall so the previous
   * session's selections come up already selected: the user can accept them
   * with Enter or adjust before continuing. Names with no matching item are
   * ignored — an item can be removed between sessions, and a stale name must
   * not render as a phantom selection.
   */
  selectedItems?: string[];
  selectedBounds?: string[];
  /**
   * The session banner drawn above the prompt: identity, bags, bounds, and the
   * session ID. It sits inside the picker rather than being logged before it
   * because inquirer repaints only its own frame — anything printed beforehand
   * scrolls away as the list grows, and the session ID is the one line a user
   * reaches back for.
   */
  header?: {
    identity?: string;
    bags?: string;
    bounds?: string;
    identityBounds?: string;
    sessionId?: string;
  };
}

export interface SessionPickerResult {
  items: string[];
  bounds?: string[];
}

interface SingleStepPickerConfig {
  message?: string;
  emptyMessage?: string;
  pageSize?: number;
  items: PickerChoice[];
  selectedItems?: string[];
  header?: SessionPickerConfig["header"];
}

const icons = {
  checked: styleText("green", figures.circleFilled),
  unchecked: figures.circle,
};

/**
 * Colour the characters the filter matched. Fuzzy matches are hard to read
 * without this — with a subsequence filter it is otherwise not obvious why a
 * given row is in the list at all.
 *
 * The active row is already cyan, so its matches go bold instead: colouring
 * them cyan too would erase the highlight exactly where the user is looking.
 */
const highlight = (
  name: string,
  indices: number[] | undefined,
  isActive: boolean,
): string => {
  const base = (s: string) => (isActive ? styleText("cyan", s) : s);
  if (!indices || indices.length === 0) return base(name);

  const matched = new Set(indices);
  let out = "";
  for (let i = 0; i < name.length; i++) {
    const char = name[i];
    out += matched.has(i)
      ? styleText(isActive ? ["cyan", "bold", "underline"] : ["cyan", "bold"], char)
      : base(char);
  }
  return out;
};

/**
 * Whether any modifier was held with this key.
 *
 * Reads `meta` off a widened shape rather than off KeypressEvent directly.
 * Node's readline sets `meta` on the object it emits — it is what distinguishes
 * Option/Cmd+Arrow (`ESC[1;3A`, `ESC[1;9A`) from a bare arrow — but inquirer's
 * KeypressEvent type declares only name/ctrl/shift, so the field is invisible to
 * the compiler. An intersection keeps the read honest: `meta` is typed as the
 * optional boolean it actually is, and the surrounding code stays fully checked.
 */
const isModified = (key: { ctrl: boolean; shift: boolean } & { meta?: boolean }): boolean =>
  key.ctrl || key.shift || key.meta === true;

type PromptContext = Parameters<ReturnType<typeof createPrompt<string[], SingleStepPickerConfig>>>[1];

const singleStepPicker = createPrompt<string[], SingleStepPickerConfig>(
  (config, done) => {
    const { pageSize = 12 } = config;
    const resolvedTheme = makeTheme({});
    const prefix = usePrefix({ status: "idle", theme: resolvedTheme });

    const [filter, setFilter] = useState("");
    // An ordered array, not a Set: the selected region renders in the order the
    // user picked, so insertion order is load-bearing rather than incidental.
    //
    // Filtered against the real item list so an item deleted since the previous
    // session does not show up as a selection the user cannot see or uncheck.
    const [selected, setSelected] = useState<string[]>(() => {
      const preselected = config.selectedItems ?? [];
      if (preselected.length === 0) return [];
      const known = new Set(config.items.map((item) => item.name));
      return preselected.filter((name) => known.has(name));
    });
    const [cursorState, setCursorState] = useState<Cursor>({ zone: "list", index: 0 });

    const allItems: Item[] = config.items.map((item) => ({
      name: item.name,
      description: item.description,
      ...(item.hint ? { hint: item.hint } : {}),
      ...(item.boundHint ? { boundHint: item.boundHint } : {}),
    }));

    // Partition before filtering: the filter narrows what is still pickable, and
    // must never hide a selected item. Filtering first would drop rows out of
    // the region as the user types, so the block recording their choices would
    // empty itself — and an item could be selected with no way to see or remove
    // it without reconstructing the query that found it.
    const { region, list } = partitionItems(allItems, selected);
    const visibleItems: Item[] = filterAndRank(filter, list);

    const regionNames = region.map((item) => item.name);
    const listNames = visibleItems.map((item) => item.name);

    const cursor = clampCursor(cursorState, region.length, visibleItems.length);

    useKeypress((key, rl) => {
      if (isEnterKey(key)) {
        done([...selected]);
        return;
      }

      // Escape clears filter
      if (key.name === "escape") {
        setFilter("");
        rl.clearLine(0);
        return;
      }

      const modified = isModified(key);
      const isJumpUp = (isUpKey(key) && modified)
        || key.name === "home"
        || key.name === "pageup";
      const isJumpDown = (isDownKey(key) && modified)
        || key.name === "end"
        || key.name === "pagedown";

      if (isJumpUp || isJumpDown) {
        setCursorState(jumpCursor(isJumpUp ? -1 : 1, region.length, visibleItems.length));
        return;
      }

      // Up/down navigation, spanning both zones — see moveCursor.
      if (isUpKey(key) || isDownKey(key)) {
        const offset = isUpKey(key) ? -1 : 1;
        setCursorState(moveCursor(cursor, offset, region.length, visibleItems.length));
        return;
      }

      // Space toggles the item under the cursor, in either zone: in the list it
      // selects, in the region it removes. Walking up into the region to remove
      // a pick is the point — it means never re-typing a query to find something
      // already found.
      if (isSpaceKey(key)) {
        rl.clearLine(0);
        setFilter("");

        const name = itemAtCursor(cursor, regionNames, listNames);
        if (name === null) return;

        setSelected(
          selected.includes(name)
            ? selected.filter((selectedName) => selectedName !== name)
            : [...selected, name],
        );
        setCursorState(cursor);
        return;
      }

      // Everything else is typing — use rl.line as the filter. The cursor jumps
      // to the list because typing is how the user reaches a new pick; leaving
      // it parked in the region would mean the first Space after a query removed
      // a selection instead of making one.
      const newFilter = rl.line;
      if (newFilter !== filter) {
        setFilter(newFilter);
        setCursorState({ zone: "list", index: 0 });
      }
    });

    // Render filter line
    const filterLine = filter
      ? `\n  ${styleText("dim", "Filter:")} ${styleText("yellow", filter)}`
      : "";

    const regionBlock = region.length === 0
      ? ""
      : [
          `\n  ${styleText("dim", `Selected (${region.length})`)}  ${styleText("dim", "space to remove")}`,
          ...region.map((item, index) => {
            const isActive = cursor.zone === "region" && cursor.index === index;
            const pointer = isActive ? styleText("cyan", figures.pointer) : " ";
            const name = isActive ? styleText("cyan", item.name) : item.name;
            const hintText = item.hint ?? item.boundHint;
            const hint = hintText ? styleText("yellow", ` [${hintText}]`) : "";
            return `${pointer} ${icons.checked} ${name}${hint}`;
          }),
          `  ${styleText("dim", "──────")}`,
        ].join("\n");

    // Render items with pagination
    const page = usePagination({
      items: visibleItems,
      active: cursor.zone === "list" ? cursor.index : -1,
      pageSize,
      renderItem({ item, isActive }) {
        const pointer = isActive ? styleText("cyan", figures.pointer) : " ";
        const name = highlight(item.name, item.matchIndices, isActive);
        const desc = item.description ? styleText("dim", ` — ${item.description}`) : "";
        const hintText = item.hint ?? item.boundHint;
        const hint = hintText ? styleText("yellow", ` [${hintText}]`) : "";
        return `${pointer} ${icons.unchecked} ${name}${hint}${desc}`;
      },
    });

    const emptyLabel = config.emptyMessage ?? "All items selected";
    const body = visibleItems.length > 0
      ? page
      : styleText("dim", filter ? "  No matches" : `  ${emptyLabel}`);

    const header = config.header;
    const headerLines = [
      header?.identity ? `  ${styleText("dim", "Identity:")} ${header.identity}` : "",
      header?.bags ? `  ${styleText("dim", "Bags:")} ${header.bags}` : "",
      header?.bounds ? `  ${styleText("dim", "Bounds:")} ${header.bounds}` : "",
      header?.identityBounds ? `  ${styleText("dim", "Identity bounds:")} ${header.identityBounds}` : "",
      header?.sessionId ? `  ${styleText("dim", "Session:")} ${styleText("dim", header.sessionId)}` : "",
    ].filter(Boolean);
    const headerBlock = headerLines.length > 0 ? `${headerLines.join("\n")}\n\n` : "";

    const message = config.message ?? "Select bags";
    const help = styleText(
      "dim",
      "(↑/↓ navigate, ⇧↑/⇧↓ jump, space select, type to filter, enter submit)",
    );

    return `${headerBlock}${prefix} ${styleText("bold", message)} ${help}${filterLine}${regionBlock}\n${body}`;
  },
);

export async function sessionPicker(
  config: SessionPickerConfig,
  context?: PromptContext,
): Promise<SessionPickerResult> {
  const items = await singleStepPicker(
    {
      message: config.message ?? "Select bags",
      emptyMessage: config.emptyMessage ?? "All items selected",
      pageSize: config.pageSize,
      items: config.items,
      selectedItems: config.selectedItems,
      header: config.header,
    },
    context,
  );

  const boundChoices = config.resolveBounds
    ? await config.resolveBounds(items)
    : (config.bounds ?? []);
  if (boundChoices.length === 0) {
    return { items };
  }

  const bounds = await singleStepPicker(
    {
      message: config.boundsMessage ?? "Select bounds",
      emptyMessage: "All bounds selected",
      pageSize: config.pageSize,
      items: boundChoices,
      selectedItems: config.selectedBounds,
      header: config.header,
    },
    context,
  );
  return { items, bounds };
}
