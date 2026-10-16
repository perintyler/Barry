import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { bounds, identityRecords, store, type IdentityEntry } from "@barry-rocks/identities-bag";
import { barryAdaptersPath, barryAppSupportDir } from "@barry-rocks/sdk/services";
import {
  convertLegacyBound,
  hasLegacyBoundKeys,
  migrateIdentityYamlObject,
  readLegacyIdentitiesSqlite,
  SHIPPED_GLOBAL_BOUND_NAMES,
  writeTextAtomicWithBackup,
  type LegacyDbBoundRow,
} from "./doctor-migration.js";

function findIdentityYamlFile(dir: string): string | null {
  const preferred = join(dir, "identity.yaml");
  if (existsSync(preferred)) return preferred;
  const legacy = join(dir, "barry.yaml");
  if (existsSync(legacy)) return legacy;
  return null;
}

function collectDeclaredBoundNames(doc: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(doc.bounds)) return out;
  for (const entry of doc.bounds) {
    if (typeof entry === "string") {
      out.add(entry);
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      if (typeof obj.name === "string") out.add(obj.name);
      else {
        const k = Object.keys(obj)[0];
        if (k) out.add(k);
      }
    }
  }
  return out;
}

function hasLegacyInlineBoundsInDoc(doc: Record<string, unknown>): boolean {
  if (!Array.isArray(doc.bounds)) return false;
  for (const entry of doc.bounds) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.name === "string" && hasLegacyBoundKeys(obj)) return true;
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      const val = obj[keys[0]];
      if (val && typeof val === "object" && !Array.isArray(val) && hasLegacyBoundKeys(val)) {
        return true;
      }
    }
  }
  return false;
}

export async function reportBoundProblems(fix: boolean): Promise<void> {
  const dbPath = typeof store?.path === "function" ? store.path() : "";
  const legacyDb = dbPath
    ? await readLegacyIdentitiesSqlite(dbPath)
    : {
        hasBoundsTable: false,
        hasTraitsTable: false,
        allBounds: [] as LegacyDbBoundRow[],
        customBounds: [] as LegacyDbBoundRow[],
        traitsByName: new Map(),
      };

  const entries = [...(await identityRecords.list())];
  const builtinDir =
    typeof identityRecords.builtinDirectory === "function" ? identityRecords.builtinDirectory() : null;
  const firstUserDir = entries.find(
    (e) => e.dir && e.record.name !== "base" && (!builtinDir || resolve(e.dir) !== resolve(builtinDir)),
  )?.dir;
  const identitiesRoot = firstUserDir ? dirname(firstUserDir) : join(barryAppSupportDir(), "identities");
  if (identitiesRoot && existsSync(identitiesRoot)) {
    for (const dirent of readdirSync(identitiesRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const subDir = join(identitiesRoot, dirent.name);
      const yamlPath = findIdentityYamlFile(subDir);
      if (!yamlPath) continue;
      if (entries.some((e) => e.dir && resolve(e.dir) === resolve(subDir))) continue;
      try {
        const rawDoc = (parse(readFileSync(yamlPath, "utf8")) as Record<string, unknown>) ?? {};
        const name = typeof rawDoc.name === "string" ? rawDoc.name : dirent.name;
        const existing = entries.find((e) => e.record.name === name);
        if (existing) {
          if (!existing.dir) {
            existing.dir = subDir;
            existing.source = "file";
          }
          continue;
        }
        entries.push({
          record: {
            id: typeof rawDoc.id === "number" ? rawDoc.id : 0,
            token: "",
            actor_id: 1,
            name,
            metadata: {
              display_name: typeof rawDoc.displayName === "string" ? rawDoc.displayName : name,
              inherits: typeof rawDoc.inherits === "string" ? rawDoc.inherits : undefined,
              bounds: Array.isArray(rawDoc.bounds) ? (rawDoc.bounds as string[]) : [],
            },
            created_at: "",
            last_used_at: null,
          },
          source: "file",
          dir: subDir,
          isDefault: false,
        });
      } catch {
        // Ignore unparseable YAML
      }
    }
  }

  const ordered: IdentityEntry[] = [];
  const visited = new Set<string>();
  function visit(entry: IdentityEntry) {
    if (visited.has(entry.record.name)) return;
    visited.add(entry.record.name);
    const parent = entries.find((candidate) => candidate.record.name === entry.record.metadata.inherits);
    if (parent) visit(parent);
    ordered.push(entry);
  }
  for (const entry of entries) visit(entry);
  const userEntries = ordered.filter(
    (entry) =>
      entry.dir !== null &&
      entry.record.name !== "base" &&
      (!builtinDir || resolve(entry.dir) !== resolve(builtinDir)),
  );
  const defaultUserEntry = userEntries.find((e) => e.isDefault) ?? userEntries[0];

  const declaredBoundNames = new Set<string>(SHIPPED_GLOBAL_BOUND_NAMES);
  for (const entry of userEntries) {
    const yamlPath = entry.dir ? findIdentityYamlFile(entry.dir) : null;
    if (!yamlPath) continue;
    try {
      const doc = parse(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
      if (doc && typeof doc === "object") {
        for (const bName of collectDeclaredBoundNames(doc)) declaredBoundNames.add(bName);
      }
    } catch {
      // Ignore unparseable YAML here
    }
  }

  const customSourceRows = legacyDb.customBounds;
  const unmigratedCustomBounds = customSourceRows.filter((row) => !declaredBoundNames.has(row.name));

  for (const entry of userEntries) {
    const name = entry.record.name;
    const yamlPath = entry.dir ? findIdentityYamlFile(entry.dir) : null;
    if (!yamlPath || !entry.dir) continue;

    let doc: Record<string, unknown>;
    try {
      doc = (parse(readFileSync(yamlPath, "utf8")) as Record<string, unknown>) ?? {};
    } catch {
      continue;
    }

    const hasInlineBound =
      Boolean(identityRecords.unqualifiedBound?.(name)) ||
      Object.hasOwn(doc, "bound") ||
      Object.hasOwn(doc, "scope");
    const hasLegacyBounds = hasLegacyInlineBoundsInDoc(doc);
    const customForThisIdentity =
      defaultUserEntry && entry.record.name === defaultUserEntry.record.name ? unmigratedCustomBounds : [];

    if (!hasInlineBound && !hasLegacyBounds && customForThisIdentity.length === 0) continue;

    if (hasInlineBound) {
      console.log(`Identity '${name}' writes restrictions inline under bound:. Run barry doctor --fix to move them into bounds:.`);
    }
    if (hasLegacyBounds) {
      console.log(
        `Identity '${name}' uses legacy bound keys in bounds:. Run barry doctor --fix to convert them to { allow, deny }.`,
      );
    }
    for (const custom of customForThisIdentity) {
      console.log(
        `Stored bound '${custom.name}' in identities.db is not in identity.yaml. Run barry doctor --fix to copy it into '${name}' bounds:.`,
      );
    }

    if (fix) {
      try {
        if (hasInlineBound) {
          const existingOwn = collectDeclaredBoundNames(doc);
          const inheritedBounds = Array.isArray(entry.record.metadata.bounds)
            ? entry.record.metadata.bounds
            : [];
          const inheritedNames = new Set<string>(SHIPPED_GLOBAL_BOUND_NAMES);
          for (const item of inheritedBounds) {
            if (typeof item === "string") inheritedNames.add(item);
            else if (item && typeof item === "object") {
              const k = Object.keys(item as Record<string, unknown>)[0];
              if (k) inheritedNames.add(k);
            }
          }
          if (existingOwn.has(name) || inheritedNames.has(name)) {
            throw new Error(`Bound ${name} is already named by the identity chain or base identity`);
          }
        }

        // Isolate bound migration from traits/bag_grant migration (which runs in reportIdentityProblems)
        const docForBounds = { ...doc };
        delete docForBounds.traits;
        delete docForBounds.bag_grant;
        const { updated } = migrateIdentityYamlObject(docForBounds, {
          identityName: name,
          customBoundsToAdd: customForThisIdentity,
        });
        const mergedDoc: Record<string, unknown> = { ...doc };
        delete mergedDoc.bound;
        delete mergedDoc.scope;
        if (updated.bounds !== undefined) {
          mergedDoc.bounds = updated.bounds;
        }
        writeTextAtomicWithBackup(yamlPath, stringify(mergedDoc), `identities/${name}/identity.yaml`);
        await identityRecords.sync(entry.dir, { actorId: entry.record.actor_id });
        if (hasInlineBound) {
          console.log(`  ${name}: moved inline restrictions into required bound '${name}'.`);
        }
        if (hasLegacyBounds) {
          console.log(`  ${name}: converted legacy inline bounds to { allow, deny }.`);
        }
        for (const custom of customForThisIdentity) {
          console.log(`  ${name}: copied custom bound '${custom.name}' into bounds:.`);
        }
      } catch (error) {
        console.log(`  ${name}: ${String(error)}; file unchanged.`);
        process.exitCode = 1;
      }
    }
  }

  if (typeof bounds?.shipped === "function") {
    for (const shipped of bounds.shipped()) {
      const row = legacyDb.allBounds.find((r) => r.name === shipped.name);
      if (!row) continue;
      const { name: _name, description: _description, ...rules } = shipped;
      if (JSON.stringify(convertLegacyBound(row.bound)) !== JSON.stringify(convertLegacyBound(rules))) {
        console.log(
          `Stored bound '${row.name}' differs from its base identity definition, which shadows it; edit identity.yaml to change the active bound.`,
        );
      }
    }
  }

  migrateAdaptersRegistry(fix);
}

export function migrateAdaptersRegistry(fix: boolean): void {
  const adaptersFile = barryAdaptersPath();
  if (!existsSync(adaptersFile)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(adaptersFile, "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;

  let changed = false;
  const migrated = parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = { ...(item as Record<string, unknown>) };
    if ("nativeTools" in record) {
      if (record.tools === undefined) record.tools = record.nativeTools;
      delete record.nativeTools;
      changed = true;
    }
    if (record.vendorCode && typeof record.vendorCode === "object" && !Array.isArray(record.vendorCode)) {
      const vendorCode = { ...(record.vendorCode as Record<string, unknown>) };
      if ("catalog" in vendorCode) {
        if (vendorCode.vendors === undefined) vendorCode.vendors = vendorCode.catalog;
        delete vendorCode.catalog;
        record.vendorCode = vendorCode;
        changed = true;
      }
    }
    if (record.modes && typeof record.modes === "object" && !Array.isArray(record.modes)) {
      const modes = { ...(record.modes as Record<string, unknown>) };
      for (const [modeName, modeValue] of Object.entries(modes)) {
        if (!modeValue || typeof modeValue !== "object" || Array.isArray(modeValue)) continue;
        const modeSpec = { ...(modeValue as Record<string, unknown>) };
        if (modeSpec.native && typeof modeSpec.native === "object" && !Array.isArray(modeSpec.native)) {
          const nativeSpec = { ...(modeSpec.native as Record<string, unknown>) };
          if ("grantable" in nativeSpec) {
            if (nativeSpec.controllable === undefined) nativeSpec.controllable = nativeSpec.grantable;
            delete nativeSpec.grantable;
            modeSpec.native = nativeSpec;
            modes[modeName] = modeSpec;
            changed = true;
          }
        }
      }
      record.modes = modes;
    }
    if (record.bag && typeof record.bag === "object" && !Array.isArray(record.bag)) {
      const bagRecord = { ...(record.bag as Record<string, unknown>) };
      if (bagRecord.manifest && typeof bagRecord.manifest === "object" && !Array.isArray(bagRecord.manifest)) {
        const manifest = { ...(bagRecord.manifest as Record<string, unknown>) };
        if ("traits" in manifest) {
          delete manifest.traits;
          changed = true;
        }
        if (manifest.bounds && typeof manifest.bounds === "object" && !Array.isArray(manifest.bounds)) {
          const boundsMap = { ...(manifest.bounds as Record<string, unknown>) };
          for (const [boundName, boundValue] of Object.entries(boundsMap)) {
            if (!boundValue || typeof boundValue !== "object" || Array.isArray(boundValue)) continue;
            const entry = { ...(boundValue as Record<string, unknown>) };
            const inner =
              entry.bound && typeof entry.bound === "object" && !Array.isArray(entry.bound)
                ? (entry.bound as Record<string, unknown>)
                : entry;
            if (hasLegacyBoundKeys(inner)) {
              const converted = convertLegacyBound(inner);
              boundsMap[boundName] = {
                ...(typeof entry.description === "string" ? { description: entry.description } : {}),
                ...converted,
                bound: converted,
              };
              changed = true;
            }
          }
          manifest.bounds = boundsMap;
        }
        bagRecord.manifest = manifest;
        record.bag = bagRecord;
      }
    }
    return record;
  });

  if (!changed) return;
  console.log(
    "Installed session adapter registry uses legacy keys. Run barry doctor --fix to update adapters.json.",
  );
  if (fix) {
    writeTextAtomicWithBackup(adaptersFile, `${JSON.stringify(migrated, null, 2)}\n`, "adapters.json");
    console.log("  adapters.json: updated installed session adapter records.");
  }
}


