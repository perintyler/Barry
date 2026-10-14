import { rotateLog } from "./logs.js";
import { acquireLock, isAlive, matchDirectoryOwner } from "@barry-rocks/sdk/internal/services";
import {
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Instance } from "@barry-rocks/sdk/internal/services";
import type { ServiceOS, JobState } from "./launchd.js";

export class ServiceRefusal extends Error {
  constructor(readonly reason: "not_found" | "forbidden" | "conflict" | "unsupported", message: string) {
    super(message);
    this.name = "ServiceRefusal";
  }
}

export interface ServiceDefinition {
  name: string;
  command: readonly string[];
  directory: string;
  domain: string;
  plistDirectory: string;
  logDirectory: string;
  user?: string;
  environment?: Record<string, string>;
  shutdownMs?: number;
  restart?: boolean;
  health?: string;
  automatic?: boolean;
  address?: string;
}
export interface ServiceChoice {
  registered: boolean;
  enabled: boolean;
  pending?: string;
}
interface RecordFile {
  instance: string;
  services: Record<string, ServiceChoice>;
}
export interface ManagedService extends JobState, ServiceChoice {
  name: string;
  label: string;
  logs: { stdoutBytes: number; stderrBytes: number; rotationRecommended: boolean };
}
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function renderService(
  definition: ServiceDefinition,
  label: string,
  enabled: boolean,
): string {
  const env = Object.entries(definition.environment ?? {})
    .map(
      ([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${definition.command.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(definition.directory)}</string>
<key>RunAtLoad</key><${enabled ? "true" : "false"}/>
<key>KeepAlive</key><${definition.restart === false ? "false" : "true"}/>
<key>Disabled</key><${enabled ? "false" : "true"}/>
<key>ExitTimeOut</key><integer>${Math.ceil((definition.shutdownMs ?? 40000) / 1000)}</integer>
<key>StandardOutPath</key><string>${xml(join(definition.logDirectory, `${definition.name}.out.log`))}</string>
<key>StandardErrorPath</key><string>${xml(join(definition.logDirectory, `${definition.name}.err.log`))}</string>
${definition.user ? `<key>UserName</key><string>${xml(definition.user)}</string>` : ""}
<key>EnvironmentVariables</key><dict>${env}</dict>
</dict></plist>\n`;
}

/** Explicit instance, declarations, and OS boundary; no global registry or running server. */
export class ServiceManagement {
  private readonly definitions: Map<string, ServiceDefinition>;
  private readonly record: string;
  constructor(
    readonly instance: Instance,
    definitions: readonly ServiceDefinition[],
    private readonly os: ServiceOS,
  ) {
    this.record = join(instance.home, "services.json");
    this.definitions = new Map();
    for (const definition of definitions) {
      if (
        !/^[a-zA-Z0-9._-]+$/.test(definition.name) ||
        definition.name.includes("..")
      )
        throw new Error(`invalid service name: ${definition.name}`);
      if (this.definitions.has(definition.name))
        throw new Error(`duplicate service: ${definition.name}`);
      if (
        !definition.command.length ||
        definition.command.some(
          (arg) => typeof arg !== "string" || arg.includes("\0"),
        )
      )
        throw new Error(`invalid command: ${definition.name}`);
      this.definitions.set(definition.name, definition);
    }
  }
  label(name: string): string {
    this.definition(name);
    return `rocks.barry.${this.instance.id}.${name}`;
  }
  definition(name: string): ServiceDefinition {
    const definition = this.definitions.get(name);
    if (!definition) throw new ServiceRefusal("not_found", `unknown service: ${name}`);
    return definition;
  }
  private read(): RecordFile {
    try {
      const value = JSON.parse(readFileSync(this.record, "utf8")) as RecordFile;
      if (
        value.instance !== this.instance.id ||
        !value.services ||
        typeof value.services !== "object"
      )
        throw new Error(`invalid service ownership record: ${this.record}`);
      for (const choice of Object.values(value.services)) {
        if (
          !choice ||
          typeof choice.registered !== "boolean" ||
          typeof choice.enabled !== "boolean" ||
          (!choice.registered && choice.enabled)
        )
          throw new Error(`invalid service choice: ${this.record}`);
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { instance: this.instance.id, services: {} };
      throw error;
    }
  }
  private save(value: RecordFile): void {
    mkdirSync(dirname(this.record), { recursive: true });
    const temporary = `${this.record}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
    matchDirectoryOwner(temporary);
    renameSync(temporary, this.record);
  }
  hasChoice(name: string): boolean {
    return Object.hasOwn(this.read().services, name);
  }
  choice(name: string): ServiceChoice {
    this.definition(name);
    return this.read().services[name] ?? { registered: false, enabled: false };
  }
  async status(name: string): Promise<ManagedService> {
    const definition = this.definition(name);
    const size = (stream: string): number => {
      try { return statSync(join(definition.logDirectory, `${name}.${stream}.log`)).size; }
      catch (error) { if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return 0; throw error; }
    };
    const stdoutBytes = size("out"), stderrBytes = size("err");
    return {
      name,
      label: this.label(name),
      ...this.choice(name),
      ...(await (this.os.observe?.(definition.domain, this.label(name)) ?? this.os.inspect(definition.domain, this.label(name)))),
      logs: { stdoutBytes, stderrBytes, rotationRecommended: Math.max(stdoutBytes, stderrBytes) >= 10 * 1024 * 1024 },
    };
  }
  names(): string[] {
    return [...this.definitions.keys()].sort();
  }
  async list(): Promise<ManagedService[]> {
    const names = this.names(), result: ManagedService[] = [];
    for (let i = 0; i < names.length; i += 6)
      result.push(...await Promise.all(names.slice(i, i + 6).map((name) => this.status(name))));
    return result;
  }
  async collectLogs(root: string): Promise<{ keys: string[]; bytes: number }> {
    const keys = new Set<string>();
    let bytes = 0;
    if (this.instance.uid === undefined) return { keys: [], bytes };
    const domain = `gui/${this.instance.uid}`;
    const loaded = new Map<string, boolean>();
    let directories;
    try { directories = readdirSync(root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { keys: [], bytes }; throw error; }
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      for (const entry of readdirSync(join(root, directory.name), { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const key = /^([A-Za-z0-9._-]+)\.(?:out|err)\.log(?:\.\d+)?$/.exec(entry.name)?.[1];
        if (!key || key.includes("..") || this.definitions.has(key)) continue;
        const path = join(root, directory.name, entry.name), stat = lstatSync(path);
        if (!stat.isFile() || Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) continue;
        if (!loaded.has(key)) {
          const label = `rocks.barry.${this.instance.id}.${key}`;
          const state = await (this.os.observe?.(domain, label) ?? this.os.inspect(domain, label));
          loaded.set(key, state.loaded);
        }
        if (loaded.get(key)) continue;
        unlinkSync(path);
        keys.add(key); bytes += stat.size;
      }
    }
    return { keys: [...keys].sort(), bytes };
  }
  private plist(name: string): string {
    return join(
      this.definition(name).plistDirectory,
      `${this.label(name)}.plist`,
    );
  }
  private writePlist(name: string, enabled: boolean): void {
    const definition = this.definition(name);
    mkdirSync(definition.plistDirectory, { recursive: true });
    mkdirSync(definition.logDirectory, { recursive: true });
    const path = this.plist(name),
      temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      renderService(definition, this.label(name), enabled),
      { mode: 0o600 },
    );
    renameSync(temporary, path);
  }
  /** Foreground and managed execution use the same competition guard. */
  assertCanStart(name: string): void {
    const definition = this.definition(name),
      label = this.label(name);
    for (const lockPath of [
      join(this.instance.home, `service-${name}.lock`),
    ])
      try {
        const owner = Number(readFileSync(lockPath, "utf8"));
        const managed = this.os.inspect(definition.domain, label).pid;
        if (isAlive(owner) && owner !== managed)
          throw new ServiceRefusal("conflict",
            `${name} is running outside launchd (pid ${owner}); stop that process before starting the managed service`,
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
  }
  async apply(
    name: string,
    operation:
      | "add"
      | "remove"
      | "enable"
      | "disable"
      | "start"
      | "stop"
      | "restart",
    options: { now?: boolean } = {},
  ): Promise<ManagedService> {
    const definition = this.definition(name);
    // Adding one is installing it: `barry service add` prepares definitions, which root may not do.
    if (this.os.canControl?.(definition.domain) === false)
      throw new ServiceRefusal("forbidden",
        `\`${name}\` runs as \`${definition.user}\` in the system domain: install or update it with \`sudo barry setup --system\`${operation === "add" ? "" : `; control it with \`sudo barry service ${operation} ${name}\``}`,
      );
    const release = acquireLock(this.instance.home, "service-management");
    try {
      const definition = this.definition(name),
        label = this.label(name);
      if (
        ["start", "restart"].includes(operation) ||
        (operation === "enable" && options.now)
      ) {
        this.assertCanStart(name);
      }
      const record = this.read(),
        previous = this.choice(name);
      if (!["add", "remove"].includes(operation) && !previous.registered)
        throw new ServiceRefusal("conflict",
          `service ${name} is not registered; run barry service add ${name}`,
        );
      // Persist intent before touching the machine; incomplete work remains visible and retryable.
      let desired = { ...previous };
      if (operation === "add") desired = { ...desired, registered: true };
      if (operation === "remove")
        desired = { registered: false, enabled: false };
      if (operation === "enable" || operation === "disable")
        desired.enabled = operation === "enable";
      record.services[name] = { ...desired, pending: operation };
      this.save(record);
      if (
        operation === "remove" ||
        operation === "stop" ||
        operation === "restart" ||
        (operation === "disable" && options.now)
      ) {
        await this.os.unload(
          definition.domain,
          label,
          definition.shutdownMs ?? 40000,
        );
      }
      if (operation === "remove") {
        this.os.enable(definition.domain, label, false);
        try {
          unlinkSync(this.plist(name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      } else if (["add", "enable", "disable"].includes(operation)) {
        this.writePlist(name, desired.enabled);
        this.os.enable(definition.domain, label, desired.enabled);
      }
      if (
        ["start", "restart"].includes(operation) ||
        (operation === "enable" && options.now)
      ) {
        // Temporarily permit manual execution; persist policy separately and restore the OS override.
        this.os.enable(definition.domain, label, true);
        try {
          if (!this.os.inspect(definition.domain, label).loaded) {
            for (const stream of ["out", "err"])
              rotateLog(
                join(definition.logDirectory, `${name}.${stream}.log`),
                { maxBytes: operation === "restart" ? 0 : 10 * 1024 * 1024 },
              );
            this.writePlist(name, true);
            this.os.load(definition.domain, this.plist(name));
          } else this.os.start(definition.domain, label);
        } finally {
          this.writePlist(name, desired.enabled);
          this.os.enable(definition.domain, label, desired.enabled);
        }
      }
      record.services[name] = {
        registered: desired.registered,
        enabled: desired.enabled,
      };
      this.save(record);
      return await this.status(name);
    } finally {
      release();
    }
  }
}
