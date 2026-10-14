import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { join } from "path";

const execFileAsync = promisify(execFile);

const BARRY_DIR = process.env.BARRY_DIR || join(process.env.HOME || "", "repos/barry");
const KEYCHAIN_BIO_PATH = join(BARRY_DIR, "scripts", "keychain-bio", "keychain-bio");

export interface KeychainConfig {
  service: string; // Keychain service name (e.g., "barry")
}

/**
 * Reads and writes the macOS login Keychain via `/usr/bin/security`.
 *
 * One declared source among four (`EnvironmentVariable`); the vault's own
 * account credentials are filed here too, which is why `openVault` reads
 * through the same class.
 */
export class KeychainProvider {
  readonly name = "macOS Keychain";
  private readonly securityPath = "/usr/bin/security";

  private readonly config: KeychainConfig;

  constructor(config: KeychainConfig) {
    this.config = config;
  }

  async get(_storeId: string, varName: string): Promise<string | null> {
    const account = varName.toLowerCase().replace(/_/g, "-");
    try {
      const { stdout } = await execFileAsync(this.securityPath, [
        "find-generic-password",
        "-s",
        this.config.service,
        "-a",
        account,
        "-w",
      ]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async set(account: string, password: string): Promise<void> {
    // Delete existing first (update = delete + add on macOS)
    try {
      await execFileAsync(this.securityPath, [
        "delete-generic-password",
        "-s",
        this.config.service,
        "-a",
        account,
      ]);
    } catch {
      // Ignore if doesn't exist
    }

    await execFileAsync(this.securityPath, [
      "add-generic-password",
      "-s",
      this.config.service,
      "-a",
      account,
      "-w",
      password,
      "-U", // Update if exists
    ]);
  }

  async delete(account: string): Promise<void> {
    try {
      await execFileAsync(this.securityPath, [
        "delete-generic-password",
        "-s",
        this.config.service,
        "-a",
        account,
      ]);
    } catch {
      // Ignore if doesn't exist
    }
  }

  async list(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(this.securityPath, [
        "dump-keychain",
      ]);

      const accounts: string[] = [];
      const lines = stdout.split("\n");
      let inBarryService = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.includes(`svce<blob>="${this.config.service}"`)) {
          inBarryService = true;
        }
        if (inBarryService && trimmed.startsWith('0x00000007 <blob>="')) {
          inBarryService = false;
        }
        if (inBarryService && trimmed.includes('"acct"<blob>="')) {
          const match = trimmed.match(/"acct"<blob>="([^"]+)"/);
          if (match) {
            accounts.push(match[1]);
          }
          inBarryService = false;
        }
      }

      return accounts;
    } catch {
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.securityPath, ["list-keychains"]);
      return true;
    } catch {
      return false;
    }
  }

  async setBiometric(service: string, account: string, value: string): Promise<void> {
    if (!existsSync(KEYCHAIN_BIO_PATH)) {
      throw new Error(`keychain-bio binary not found at ${KEYCHAIN_BIO_PATH}. Run scripts/keychain-bio/build.sh first.`);
    }
    execFileSync(KEYCHAIN_BIO_PATH, ["set", service, account], { input: value });
  }

  async getBiometric(service: string, account: string): Promise<string | null> {
    if (!existsSync(KEYCHAIN_BIO_PATH)) {
      throw new Error(`keychain-bio binary not found at ${KEYCHAIN_BIO_PATH}. Run scripts/keychain-bio/build.sh first.`);
    }
    try {
      const { stdout } = await execFileAsync(KEYCHAIN_BIO_PATH, ["get", service, account]);
      return stdout || null;
    } catch {
      return null;
    }
  }

  async deleteBiometric(service: string, account: string): Promise<void> {
    if (!existsSync(KEYCHAIN_BIO_PATH)) return;
    try {
      await execFileAsync(KEYCHAIN_BIO_PATH, ["delete", service, account]);
    } catch {
      // Ignore
    }
  }
}
