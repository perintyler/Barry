/**
 * Markdown-to-terminal renderer.
 *
 * Takes markdown with color tags and produces ANSI-formatted CLI output.
 * Zero dependencies.
 *
 * Color extension syntax (double-angle tags to avoid HTML clashes):
 *   <<red>>text<</red>>  <<green>>text<</green>>  <<yellow>>text<</yellow>>
 *   <<blue>>text<</blue>>  <<magenta>>text<</magenta>>  <<cyan>>text<</cyan>>
 *
 * Standard markdown:
 *   **bold**        → bold
 *   *dim*           → dim
 *   `code`          → cyan
 *   # Header        → bold with newline prefix
 *   ---             → dim separator line
 *   - item          → bulleted list with › prefix
 *   [x] done        → green ✓
 *   [ ] todo        → dim ○
 *   [!] warning     → yellow !
 *   [~] loading     → cyan ⟳
 */

export function isColorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR === "0") return false;
  if (process.env.FORCE_COLOR === "1") return true;
  return process.stdout.isTTY === true;
}

const code = (n: string) => (isColorEnabled() ? `\x1b[${n}m` : "");


export const bold = (s: string) => `${code("1")}${s}${code("0")}`;
export const dim = (s: string) => `${code("2")}${s}${code("0")}`;

export const red = (s: string) => `${code("31")}${s}${code("39")}`;
export const green = (s: string) => `${code("32")}${s}${code("39")}`;
export const yellow = (s: string) => `${code("33")}${s}${code("39")}`;
export const blue = (s: string) => `${code("34")}${s}${code("39")}`;
export const magenta = (s: string) => `${code("35")}${s}${code("39")}`;
export const cyan = (s: string) => `${code("36")}${s}${code("39")}`;

export const ok = (msg: string) => `  ${green("✓")} ${msg}`;
export const fail = (msg: string) => `  ${red("✗")} ${msg}`;
export const warn = (msg: string) => `  ${yellow("!")} ${msg}`;
export const info = (msg: string) => `  ${cyan("○")} ${msg}`;
export const spin = (msg: string) => `  ${cyan("⟳")} ${msg}`;
export const bullet = (msg: string) => `  ${dim("›")} ${msg}`;

export const header = (title: string) => `\n${bold(title)}`;

export const line = (width = 40) => dim("─".repeat(width));


const COLOR_FNS: Record<string, (s: string) => string> = {
  red, green, yellow, blue, magenta, cyan, bold, dim,
};

/**
 * Render inline formatting within a single line of text.
 * Handles: color tags, **bold**, *dim*, `code`
 */
function renderInline(text: string): string {
  let result = text;

  // Color tags: <<red>>...<</red>> (supports nesting by processing innermost first)
  let prev = "";
  while (prev !== result) {
    prev = result;
    result = result.replace(
      /<<(red|green|yellow|blue|magenta|cyan|bold|dim)>>(.*?)<<\/\1>>/gs,
      (_match, tag: string, content: string) => {
        const fn = COLOR_FNS[tag];
        return fn ? fn(content) : content;
      }
    );
  }

  // **bold**
  result = result.replace(/\*\*(.+?)\*\*/g, (_m, content: string) => bold(content));

  // *dim* (but not inside ** which we already handled)
  result = result.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, (_m, content: string) => dim(content));

  // `code`
  result = result.replace(/`([^`]+?)`/g, (_m, content: string) => cyan(content));

  return result;
}

/**
 * Render a single line, handling block-level syntax.
 */
function renderLine(raw: string): string {
  const trimmed = raw.trimEnd();

  // Horizontal rule: --- or *** or ___
  if (/^-{3,}$|^\*{3,}$|^_{3,}$/.test(trimmed)) {
    return line(40);
  }

  // Headers: # Header
  const headerMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
  if (headerMatch) {
    return bold(renderInline(headerMatch[2]));
  }

  // Checkbox: [x] done
  if (trimmed.startsWith("[x] ")) {
    return ok(renderInline(trimmed.slice(4)));
  }
  // Checkbox: [ ] todo
  if (trimmed.startsWith("[ ] ")) {
    return info(renderInline(trimmed.slice(4)));
  }
  // Checkbox: [!] warning
  if (trimmed.startsWith("[!] ")) {
    return warn(renderInline(trimmed.slice(4)));
  }
  // Checkbox: [~] loading
  if (trimmed.startsWith("[~] ")) {
    return spin(renderInline(trimmed.slice(4)));
  }

  // Unordered list: - item or * item
  const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
  if (listMatch) {
    return bullet(renderInline(listMatch[1]));
  }

  // Blockquote: > text
  const quoteMatch = trimmed.match(/^>\s?(.*)$/);
  if (quoteMatch) {
    return `  ${dim("│")} ${dim(renderInline(quoteMatch[1]))}`;
  }

  return renderInline(raw);
}

/**
 * Render markdown string to ANSI-formatted terminal output.
 *
 * @example
 * ```ts
 * import { seeli } from "./ansi.js";
 *
 * console.log(seeli(`
 * # Deploy
 * ---
 * [x] Dependencies installed
 * [x] Shared packages built
 * [~] Building **web**...
 * [ ] Restart services
 * [!] <<yellow>>2 uncommitted changes<</yellow>>
 * `));
 * ```
 */
export function seeli(md: string): string {
  const lines = md.replace(/^\n/, "").replace(/\n$/, "").split("\n");
  return lines.map(renderLine).join("\n");
}

export default seeli;
