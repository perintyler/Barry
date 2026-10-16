import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { Barry } from "@barry-rocks/sdk";
import { identityRecords, isNumericIdentityName, store, type IdentityEntry } from "@barry-rocks/identities-bag";
import { adaptersFromRetired, defaultHarness, FALLBACK_HARNESS, mergeAdapters } from "@barry-rocks/sdk/internal/identities";
import { findInstalled } from "@barry-rocks/sdk/adapters/harnesses";
import { installedModels } from "@barry-rocks/sdk/adapters/models";
import { loadRegistry } from "@barry-rocks/sdk/internal/bags";
import {
  backupBeforeDoctorWrite,
  migrateIdentityYamlObject,
  readLegacyIdentitiesSqlite,
  writeTextAtomicWithBackup,
} from "./doctor-migration.js";

function findNestedBagExtensions(rawBags: unknown): boolean {
  if (!Array.isArray(rawBags)) return false;
  return rawBags.some(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      !("name" in entry) &&
      Object.values(entry as Record<string, unknown>).some(
        (v) => v && typeof v === "object" && Array.isArray((v as { extensions?: unknown }).extensions),
      ),
  );
}

/** Migrate parents first, so a child's writer compares against the new inherited settings. */
export async function reportIdentityProblems(fix: boolean): Promise<void> {
  const entries = await identityRecords.list();
  const ordered: IdentityEntry[] = [];
  const visited = new Set<string>();
  function visit(entry: IdentityEntry): void {
    if (visited.has(entry.record.name)) return;
    visited.add(entry.record.name);
    const parent = entries.find((candidate) => candidate.record.name === entry.record.metadata.inherits);
    if (parent) visit(parent);
    ordered.push(entry);
  }
  for (const entry of entries) visit(entry);

  const builtinDir =
    typeof identityRecords.builtinDirectory === "function" ? identityRecords.builtinDirectory() : null;
  const dbPath = typeof store?.path === "function" ? store.path() : "";
  const legacyDb = dbPath ? await readLegacyIdentitiesSqlite(dbPath) : null;
  let installedBagNames: Set<string> | undefined;
  try {
    installedBagNames = new Set(Object.keys(loadRegistry()));
  } catch {
    installedBagNames = undefined;
  }

  const pending = ordered.filter((entry) => Object.keys(identityRecords.retired(entry.record.name)).length);
  const records = pending.length ? (await (await import("../adapters/installed.js")).adapterStore()).adapters.installed() : [];
  if (pending.length) await (await import("../lib/models-install.js")).ensureModelsInstalled();
  const vendors = pending.length ? installedModels().vendors() : [];

  for (const listed of ordered) {
    const name = listed.record.name;
    if (isNumericIdentityName(name)) {
      console.log(
        `Identity '${name}' is digits only and shadows row id ${Number(name)}. Rename it by hand in ${listed.dir ?? "the identities store"}, update the registry and any matching Keychain account names; doctor never renames identities.`,
      );
      process.exitCode = 1;
      continue;
    }
    const { record, dir } = await identityRecords.find(name);
    try {
      defaultHarness(record.metadata.adapters ?? {});
    } catch (error) {
      console.log(`Identity '${name}': ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      continue;
    }

    const isBuiltin =
      name === "base" || Boolean(dir && builtinDir && resolve(dir) === resolve(builtinDir));
    const path =
      dir && !isBuiltin
        ? join(dir, existsSync(join(dir, "identity.yaml")) ? "identity.yaml" : "barry.yaml")
        : undefined;

    if (path && existsSync(path)) {
      const own = (parse(readFileSync(path, "utf8")) as Record<string, unknown>) ?? {};
      const legacyGrantKey = ["bag", "grant"].join("_");
      const legacyTraitKeys: string[] = [];
      if (Object.hasOwn(own, "traits")) legacyTraitKeys.push("traits");
      if (Object.hasOwn(own, legacyGrantKey)) legacyTraitKeys.push(legacyGrantKey);
      if (findNestedBagExtensions(own.bags)) legacyTraitKeys.push("bags.*.extensions");

      if (legacyTraitKeys.length > 0) {
        console.log(
          `Identity '${name}' uses legacy trait/grant keys (${legacyTraitKeys.join(", ")}). Run barry doctor --fix to rewrite them as bags and bounds.`,
        );
        if (fix && dir) {
          try {
            const docForTraits = { ...own };
            delete docForTraits.bound;
            delete docForTraits.scope;
            const { updated, changes } = migrateIdentityYamlObject(docForTraits, {
              identityName: name,
              traitsTableMap: legacyDb?.traitsByName,
              installedBagNames,
            });
            const merged: Record<string, unknown> = { ...own };
            delete merged.traits;
            delete merged[legacyGrantKey];
            if (updated.bags !== undefined) merged.bags = updated.bags;
            if (updated.bounds !== undefined) merged.bounds = updated.bounds;
            writeTextAtomicWithBackup(path, stringify(merged), `identities/${name}/identity.yaml`);
            await identityRecords.sync(dir, { actorId: record.actor_id });
            console.log(`  ${name}: ${changes.join("; ")}.`);
          } catch (error) {
            console.log(
              `  Could not migrate '${name}': ${error instanceof Error ? error.message : String(error)}. Edit its identity.yaml by hand.`,
            );
            process.exitCode = 1;
          }
        }
      }
    }

    const retired = identityRecords.retired(name);
    const keys = Object.keys(retired);
    if (!keys.length) continue;
    console.log(`Identity '${name}' uses retired keys: ${keys.join(", ")}. Run barry doctor --fix to rewrite them as adapters.`);
    if (!fix) continue;
    try {
      const own = path && existsSync(path) ? (parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
      const parentName = record.metadata.inherits;
      const parent = parentName ? (await identityRecords.find(parentName)).record.metadata.adapters ?? {} : {};
      const converted = Object.hasOwn(own, "adapters")
        ? { adapters: {}, notes: [], problems: [] }
        : adaptersFromRetired(retired, {
            harness: (id) => findInstalled(records, id)?.id,
            isVendor: (id) => vendors.some((vendor) => vendor.id === id && (vendor.compatible?.length ?? 0) > 0),
            runsOn: defaultHarness(parent) ?? FALLBACK_HARNESS,
          });
      if (converted.problems.length) {
        console.log(`  ${name}: ${converted.problems.join("; ")}. Edit ${path} by hand; file unchanged.`);
        process.exitCode = 1;
        continue;
      }
      if (path) backupBeforeDoctorWrite(path, `identities/${name}/identity.yaml`);
      const adapters = mergeAdapters(record.metadata.adapters ?? {}, converted.adapters);
      await Barry.identity(name).update({ adapters });
      console.log(`  ${name} became adapters: ${JSON.stringify(adapters)}; removed ${keys.join(", ")}.`);
      for (const note of converted.notes) console.log(`  ${note}`);
    } catch (error) {
      console.log(
        `  Could not migrate '${name}': ${error instanceof Error ? error.message : String(error)}. Edit its identity.yaml by hand.`,
      );
      process.exitCode = 1;
    }
  }
}

