import { writeAntigravityWorkspace } from "./workspace.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OfferedModel } from "@barry-rocks/sdk/adapters/harnesses";
import { PIN_ENV, resolveAntigravityBin } from "./bin.js";

const execFileAsync = promisify(execFile);

export const ANTIGRAVITY_OFFERED_MODELS: readonly OfferedModel[] = [
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
  { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
  { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
  { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

export function parseAntigravityModelListing(raw: string): string[] {
  const models: string[] = [];
  for (const line of raw.split("\n")) {
    const clean = line.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧\s]+Fetching available models\.\.\./g, "").trim();
    if (!clean) continue;
    const match = /^([a-zA-Z0-9_.-]+)\s{2,}(.+)$/.exec(clean);
    if (match) {
      models.push(match[1]);
    }
  }
  return models;
}

export async function listAntigravityModels(options: { env: Readonly<Record<string, string | undefined>> } = { env: {} }): Promise<string[]> {
  if (!options.env.GEMINI_API_KEY) return ANTIGRAVITY_OFFERED_MODELS.map(model => model.id);
  const bin = resolveAntigravityBin();
  const { workspaceDir: home } = writeAntigravityWorkspace({ sessionId: "model-listing", cwd: process.cwd(), env: {}, mcpServers: {} });
  try {
    const { stdout } = await execFileAsync(bin, ["models"], {
      encoding: "utf-8",
      timeout: 10_000,
      cwd: home,
      env: { HOME: home, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, GEMINI_API_KEY: options.env.GEMINI_API_KEY, ...PIN_ENV },
    });
    const parsed = parseAntigravityModelListing(stdout);
    if (parsed.length > 0) return parsed;
  } catch {
    /* fallback to offered */
  }
  return ANTIGRAVITY_OFFERED_MODELS.map((m) => m.id);
}
