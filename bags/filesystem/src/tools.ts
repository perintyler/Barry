import { Barry } from "@barry-rocks/sdk";
import { mcpResult, resolveUserPath } from "@barry-rocks/sdk/tools";
import { z } from "zod";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  chmodSync,
  openSync,
  readSync,
  closeSync,
  type Dirent,
} from "fs";
import { join, relative, dirname, basename, extname } from "path";
import { execFileSync, execFile } from "child_process";

const PATH_HINT =
  "Absolute path preferred; a relative path resolves against the MCP server's working directory; ~ expands to the user's home.";

const MAX_READ_LIMIT = 10_000;
const MAX_LINE_CHARS = 2000;
const RG_MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_GREP_LINES = 1000;
const MAX_LS_ENTRIES = 2000;
const MAX_GLOB_STAT_ENTRIES = 10_000;

function readLines(
  filePath: string,
  offset: number,
  limit: number,
): { lines: string[]; totalLines: number } {
  const content = readFileSync(filePath, "utf-8");
  if (content === "") return { lines: [], totalLines: 0 };
  const allLines = content.split("\n");
  // A trailing newline produces a phantom final "" element — drop it so
  // totalLines reports what an editor would.
  if (allLines.length > 1 && allLines[allLines.length - 1] === "") allLines.pop();
  const totalLines = allLines.length;
  const start = Math.max(0, offset - 1); // 1-based → 0-based
  const sliced = allLines
    .slice(start, start + limit)
    .map((line) =>
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line,
    );
  return { lines: sliced, totalLines };
}

function formatWithLineNumbers(lines: string[], startLine: number): string {
  const maxNum = startLine + lines.length - 1;
  const width = String(Math.max(maxNum, startLine)).length;
  return lines
    .map((line, i) => {
      const num = String(startLine + i).padStart(width, " ");
      return `${num}\t${line}`;
    })
    .join("\n");
}

interface ExecError {
  code?: string;
  status?: number | null;
  signal?: string | null;
  killed?: boolean;
  stderr?: string | Buffer;
}

/**
 * Turn a ripgrep execFileSync failure into either "no matches" (rg exit 1 —
 * the ONLY benign case) or a thrown error that says what actually went wrong.
 * The old blanket catch reported every failure — missing rg, buffer overflow,
 * timeout, permissions — as an empty result, which is actively misleading.
 */
export function classifyRgError(err: unknown, op: "Glob" | "Grep"): "no_matches" {
  const e = (err ?? {}) as ExecError;
  if (e.status === 1) return "no_matches";
  if (e.code === "ENOENT") {
    throw new Error(
      `${op} failed: ripgrep (rg) is not installed or not on the MCP server's PATH. Install with: brew install ripgrep`,
    );
  }
  if (e.code === "ENOBUFS") {
    throw new Error(
      `${op} failed: results exceeded the 10MB buffer. Narrow the pattern or search a smaller directory.`,
    );
  }
  if (e.code === "ETIMEDOUT" || e.killed || e.signal === "SIGTERM") {
    throw new Error(`${op} timed out. Narrow the pattern or search a smaller directory.`);
  }
  const stderr = e.stderr ? String(e.stderr).trim() : "";
  const detail = stderr !== "" ? stderr.slice(0, 500) : err instanceof Error ? err.message : String(err);
  throw new Error(`${op} failed: ${detail}`);
}

let atomicWriteSequence = 0;

/**
 * Write via same-directory temp file + rename so an interrupted write can
 * never leave a half-written file where a good one used to be.
 */
function writeFileAtomic(filePath: string, content: string): void {
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.tmp-${process.pid}-${(atomicWriteSequence += 1)}`,
  );
  try {
    writeFileSync(temporaryPath, content, "utf-8");
    if (existsSync(filePath)) {
      try {
        chmodSync(temporaryPath, statSync(filePath).mode);
      } catch {
        // Mode preservation is best-effort.
      }
    }
    renameSync(temporaryPath, filePath);
  } catch (err) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Temp file never made it to disk.
    }
    throw err;
  }
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** True when the first 8KB contain a NUL byte — the classic binary sniff. */
function looksBinary(filePath: string): boolean {
  const fd = openSync(filePath, "r");
  try {
    const fileBytes = Buffer.alloc(8192);
    const bytesRead = readSync(fd, fileBytes, 0, fileBytes.length, 0);
    for (let i = 0; i < bytesRead; i++) if (fileBytes[i] === 0) return true;
    return false;
  } finally {
    closeSync(fd);
  }
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Read a file for EDITING. Refuses binary/UTF-16 (NUL sniff) and non-UTF-8
 * text (latin-1 etc.): the write side is hard-coded UTF-8, so editing such a
 * file would silently corrupt it on round-trip.
 */
function readTextFileForEdit(resolvedPath: string, filePath: string): string {
  if (statSync(resolvedPath).size > 0 && looksBinary(resolvedPath)) {
    throw new Error(
      `Cannot edit binary or UTF-16 file: ${filePath}. Use Bash with an appropriate tool instead.`,
    );
  }
  const fileBytes = readFileSync(resolvedPath);
  try {
    return strictUtf8.decode(fileBytes);
  } catch {
    throw new Error(
      `${filePath} is not valid UTF-8 (likely latin-1 or another legacy encoding). ` +
        `Editing would corrupt it — convert it first (e.g. iconv -f latin1 -t utf-8) or use Bash.`,
    );
  }
}

export const fsRead = Barry.Tool({
  namespace: "filesystem",
  access: "read",
  name: "Read",
  description:
    "Read a file from the host filesystem. Returns content with line numbers " +
    "(PNG/JPEG/GIF/WebP images are returned as images). Use offset/limit for " +
    "large files; lines longer than 2000 chars are truncated.",
  schema: {
    file_path: z.string().describe(`Path to the file. ${PATH_HINT}`),
    offset: z.number().optional().describe("Line number to start from (1-based)"),
    limit: z.number().optional().describe(`Max lines to read (default 2000, max ${MAX_READ_LIMIT})`),
  },
  handler: async ({ file_path, offset, limit }) => {
    const resolvedPath = resolveUserPath(file_path);
    if (!existsSync(resolvedPath)) throw new Error(`File not found: ${file_path}`);
    const stat = statSync(resolvedPath);
    if (stat.isDirectory()) throw new Error(`Path is a directory: ${file_path}`);

    const imageMime = IMAGE_MIME_BY_EXT[extname(resolvedPath).toLowerCase()];
    if (imageMime) {
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new Error(
          `Image is ${(stat.size / (1024 * 1024)).toFixed(1)}MB (max 4MB to read inline). ` +
            `Use Bash with an image tool (sips, magick) to downscale it first.`,
        );
      }
      const data = readFileSync(resolvedPath).toString("base64");
      return mcpResult({ content: [{ type: "image" as const, data, mimeType: imageMime }] });
    }
    if (stat.size > 0 && looksBinary(resolvedPath)) {
      throw new Error(
        `Cannot read binary file (${extname(resolvedPath) || "no extension"}). ` +
          `Use Bash with an appropriate tool (file, xxd, strings) instead.`,
      );
    }

    const startLine = Math.max(1, offset ?? 1);
    const maxLines = Math.min(Math.max(1, limit ?? 2000), MAX_READ_LIMIT);
    const { lines, totalLines } = readLines(resolvedPath, startLine, maxLines);

    if (totalLines === 0) return "(empty file)";
    if (lines.length === 0) {
      return `(offset ${startLine} is past the end of the file — it has ${totalLines} lines)`;
    }

    const formatted = formatWithLineNumbers(lines, startLine);
    const lastShown = startLine + lines.length - 1;
    if (lastShown < totalLines) {
      return `${formatted}\n\n(showing lines ${startLine}–${lastShown} of ${totalLines}; continue with offset=${lastShown + 1})`;
    }
    return formatted;
  },
});

export const fsWrite = Barry.Tool({
  namespace: "filesystem",
  access: "write",
  name: "Write",
  description:
    "Write content to a file on the host filesystem. Overwrites if the file exists; " +
    "creates parent directories as needed.",
  schema: {
    file_path: z.string().describe(`Path to the file. ${PATH_HINT}`),
    content: z.string().describe("Content to write"),
  },
  handler: async ({ file_path, content }) => {
    const resolvedPath = resolveUserPath(file_path);
    if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
      throw new Error(`Path is a directory: ${file_path}`);
    }
    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileAtomic(resolvedPath, content);
    return `Wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${file_path}`;
  },
});

/** Collapse runs of whitespace so near-miss comparison ignores indentation. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Why an exact match failed, with enough signal for the agent's next step.
 * Matching stays EXACT by design — this only improves the error.
 */
function notFoundDiagnostic(content: string, oldString: string, filePath: string): string {
  const firstLine = oldString.split("\n").find((l) => normalizeWhitespace(l) !== "");
  if (firstLine !== undefined) {
    const target = normalizeWhitespace(firstLine);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (normalizeWhitespace(lines[i]) === target) {
        return (
          `old_string not found in ${filePath}. Nearest match at line ${i + 1} differs only in ` +
          `whitespace/indentation — Read the file and copy the exact text, including leading whitespace.`
        );
      }
    }
  }
  if (content.includes("\r\n") && oldString.includes("\n") && !oldString.includes("\r\n")) {
    return (
      `old_string not found in ${filePath}. The file uses CRLF line endings; ` +
      `your old_string likely has bare \\n. Read the file and copy the exact text.`
    );
  }
  return (
    `old_string not found in ${filePath}. The content may have changed — ` +
    `Read the file and retry with the exact current text.`
  );
}

/** A few numbered lines around the first replacement, as post-edit feedback. */
function editSnippet(newContent: string, replacementStartIndex: number, newString: string): string {
  const lineOfEdit = newContent.slice(0, replacementStartIndex).split("\n").length;
  const newLines = newContent.split("\n");
  if (newLines.length > 1 && newLines[newLines.length - 1] === "") newLines.pop();
  const editSpan = newString.split("\n").length;
  const start = Math.max(1, lineOfEdit - 2);
  const end = Math.min(newLines.length, lineOfEdit + editSpan + 1);
  const shown = newLines
    .slice(start - 1, end)
    .map((line) =>
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line,
    );
  return formatWithLineNumbers(shown, start);
}

export const fsEdit = Barry.Tool({
  namespace: "filesystem",
  access: "write",
  name: "Edit",
  description:
    "Replace an exact string in a file. The old_string must appear exactly once " +
    "unless replace_all is true. Matching is exact — copy text from Read, including whitespace.",
  schema: {
    file_path: z.string().describe(`Path to the file. ${PATH_HINT}`),
    old_string: z.string().describe("Exact text to find"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().default(false).describe("Replace all occurrences"),
  },
  handler: async ({ file_path, old_string, new_string, replace_all }) => {
    const resolvedPath = resolveUserPath(file_path);
    if (!existsSync(resolvedPath)) throw new Error(`File not found: ${file_path}`);

    const content = readTextFileForEdit(resolvedPath, file_path);
    const applied = applyOneEdit(content, { old_string, new_string, replace_all }, file_path);

    writeFileAtomic(resolvedPath, applied.content);
    const snippet = editSnippet(applied.content, applied.firstIndex, new_string);
    return `Replaced ${applied.count} occurrence(s) in ${file_path}.\n\n${snippet}`;
  },
});

interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** Edit's full matching rules against in-memory content — shared with MultiEdit. */
function applyOneEdit(
  content: string,
  { old_string, new_string, replace_all }: EditSpec,
  filePath: string,
): { content: string; count: number; firstIndex: number } {
  if (old_string === new_string) {
    throw new Error("old_string and new_string are identical — no change to make.");
  }
  if (old_string === "") {
    throw new Error("old_string is empty — provide the exact text to replace.");
  }

  const count = content.split(old_string).length - 1;
  if (count === 0) throw new Error(notFoundDiagnostic(content, old_string, filePath));
  if (count > 1 && !replace_all) {
    throw new Error(
      `Found ${count} matches of old_string. Set replace_all=true to replace all, ` +
      `or provide more context to uniquely identify the instance.`,
    );
  }

  const firstIndex = content.indexOf(old_string);
  const next = replace_all
    ? content.replaceAll(old_string, new_string)
    : content.replace(old_string, new_string);
  return { content: next, count: replace_all ? count : 1, firstIndex };
}

export const fsMultiEdit = Barry.Tool({
  namespace: "filesystem",
  access: "write",
  name: "MultiEdit",
  description:
    "Apply several exact string replacements to one file in a single atomic operation. " +
    "Edits apply in order against the in-memory result of the previous edit; if any edit " +
    "fails, nothing is written. Same matching rules as Edit.",
  schema: {
    file_path: z.string().describe(`Path to the file. ${PATH_HINT}`),
    edits: z
      .array(
        z.object({
          old_string: z.string().describe("Exact text to find"),
          new_string: z.string().describe("Replacement text"),
          replace_all: z.boolean().optional().default(false).describe("Replace all occurrences"),
        }),
      )
      .min(1)
      .describe("Edits applied sequentially"),
  },
  handler: async ({ file_path, edits }) => {
    const resolvedPath = resolveUserPath(file_path);
    if (!existsSync(resolvedPath)) throw new Error(`File not found: ${file_path}`);

    let content = readTextFileForEdit(resolvedPath, file_path);
    let totalReplacements = 0;
    let lastResult: { firstIndex: number; new_string: string } | null = null;

    for (let i = 0; i < edits.length; i++) {
      try {
        const applied = applyOneEdit(content, edits[i], file_path);
        content = applied.content;
        totalReplacements += applied.count;
        lastResult = { firstIndex: applied.firstIndex, new_string: edits[i].new_string };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`edit ${i + 1}/${edits.length}: ${message} (no edits were applied)`);
      }
    }

    writeFileAtomic(resolvedPath, content);
    const summary = `Applied ${edits.length} edit(s) (${totalReplacements} replacement(s)) to ${file_path}.`;
    if (lastResult === null) return summary;
    const snippet = editSnippet(content, lastResult.firstIndex, lastResult.new_string);
    return `${summary}\n\n${snippet}`;
  },
});

export const fsGlob = Barry.Tool({
  namespace: "filesystem",
  access: "read",
  name: "Glob",
  description:
    "Find files matching a glob pattern via ripgrep (`rg --files --glob`; gitignore-style " +
    "globs, .gitignore respected, hidden files skipped). Returns paths relative to the " +
    "search directory, most recently modified first.",
  schema: {
    pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.js")'),
    path: z.string().optional().describe(`Directory to search in (default: cwd). ${PATH_HINT}`),
  },
  handler: async ({ pattern, path }) => {
    const dir = resolveUserPath(path ?? process.cwd());
    if (!existsSync(dir)) throw new Error(`Directory not found: ${dir}`);

    try {
      const result = execFileSync(
        "rg",
        ["--files", "--glob", pattern, dir],
        { encoding: "utf-8", maxBuffer: RG_MAX_BUFFER_BYTES, timeout: 10000 },
      );
      const files = result.trim().split("\n").filter(Boolean);
      if (files.length === 0) return "No files found";
      if (files.length > MAX_GLOB_STAT_ENTRIES) {
        // Too many to stat cheaply — alphabetical, with an honest note.
        return (
          files.map((f) => relative(dir, f) || f).sort().join("\n") +
          `\n\n(${files.length} files — too many to sort by modification time; sorted alphabetically)`
        );
      }
      const withMtime = files.map((f) => {
        let mtime = 0;
        try {
          mtime = statSync(f).mtimeMs;
        } catch {
          // Deleted between listing and stat — sorts last.
        }
        return { rel: relative(dir, f) || f, mtime };
      });
      withMtime.sort((a, b) => b.mtime - a.mtime || a.rel.localeCompare(b.rel));
      return withMtime.map((f) => f.rel).join("\n");
    } catch (err) {
      classifyRgError(err, "Glob");
      return "No files found";
    }
  },
});

export const fsGrep = Barry.Tool({
  namespace: "filesystem",
  access: "read",
  name: "Grep",
  description:
    "Search file contents using ripgrep. output_mode: content (matching lines), " +
    "files_with_matches (paths only — cheapest for locating files), count (per-file match counts).",
  schema: {
    pattern: z.string().describe("Regex pattern to search for (ripgrep syntax)"),
    path: z.string().optional().describe(`File or directory to search in (default: cwd). ${PATH_HINT}`),
    glob: z.string().optional().describe('Glob to filter files (e.g. "*.ts")'),
    type: z.string().optional().describe('ripgrep file type filter (e.g. "ts", "py", "rust")'),
    context: z.number().optional().describe("Lines of context around each match (content mode)"),
    output_mode: z
      .enum(["content", "files_with_matches", "count"])
      .optional()
      .default("content")
      .describe("What to return (default content)"),
    case_insensitive: z.boolean().optional().describe("Case-insensitive search (-i)"),
    multiline: z
      .boolean()
      .optional()
      .describe("Let the pattern span lines (-U --multiline-dotall; . matches newlines)"),
    fixed_strings: z.boolean().optional().describe("Treat pattern as a literal string, not a regex (-F)"),
    max_results: z
      .number()
      .optional()
      .default(50)
      .describe(`Max total output lines returned across all files (default 50, max ${MAX_GREP_LINES})`),
  },
  handler: async ({
    pattern,
    path,
    glob,
    type,
    context,
    output_mode,
    case_insensitive,
    fixed_strings,
    multiline,
    max_results,
  }) => {
    const dir = resolveUserPath(path ?? process.cwd());
    if (!existsSync(dir)) throw new Error(`Path not found: ${dir}`);

    const mode = output_mode ?? "content";
    const maxLines = Math.min(Math.max(1, max_results ?? 50), MAX_GREP_LINES);
    const args = ["--color", "never"];
    if (mode === "files_with_matches") args.push("-l");
    else if (mode === "count") args.push("--count");
    else {
      args.push("--no-heading", "--line-number");
      if (context) args.push("-C", String(context));
      // NOTE: rg's -m caps matches PER FILE, so it cannot implement max_results.
      // It stays only as a runaway guard; the real cap is applied to the output.
      args.push("-m", String(MAX_GREP_LINES));
    }
    if (case_insensitive) args.push("-i");
    if (fixed_strings) args.push("-F");
    if (multiline) args.push("-U", "--multiline-dotall");
    if (glob) args.push("--glob", glob);
    if (type) args.push("--type", type);
    args.push(pattern, dir);

    try {
      const result = execFileSync("rg", args, {
        encoding: "utf-8",
        maxBuffer: RG_MAX_BUFFER_BYTES,
        timeout: 15000,
      });
      const lines = result.trimEnd().split("\n").filter(Boolean);
      if (lines.length === 0) return "No matches found";
      if (lines.length > maxLines) {
        return (
          lines.slice(0, maxLines).join("\n") +
          `\n\n(showing first ${maxLines} of ${lines.length}+ matching lines — refine the pattern, path, or glob to see the rest)`
        );
      }
      return lines.join("\n");
    } catch (err) {
      classifyRgError(err, "Grep");
      return "No matches found";
    }
  },
});

export const fsLs = Barry.Tool({
  namespace: "filesystem",
  access: "read",
  name: "LS",
  description:
    "List directory contents with file sizes and types, sorted alphabetically. " +
    "Inside a git repo, ignored entries are marked [gitignored].",
  schema: {
    path: z.string().describe(`Directory path to list. ${PATH_HINT}`),
    all: z.boolean().optional().default(false).describe("Include hidden files"),
  },
  handler: async ({ path: dirPath, all }) => {
    const resolvedPath = resolveUserPath(dirPath);
    if (!existsSync(resolvedPath)) throw new Error(`Path not found: ${dirPath}`);
    const stat = statSync(resolvedPath);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

    const entries: Dirent[] = readdirSync(resolvedPath, { withFileTypes: true });
    const filtered = (all ? entries : entries.filter((e) => !e.name.startsWith(".")))
      .sort((a, b) => a.name.localeCompare(b.name));

    const capped = filtered.slice(0, MAX_LS_ENTRIES);
    const ignored = gitIgnoredNames(resolvedPath, capped.map((e) => e.name));
    const lines = capped.map((entry) => {
      const marker = ignored.has(entry.name) ? "  [gitignored]" : "";
      const fullPath = join(resolvedPath, entry.name);
      if (entry.isDirectory()) return `${entry.name}/${marker}`;
      try {
        const s = statSync(fullPath);
        const size = formatSize(s.size);
        return `${entry.name}  (${size})${marker}`;
      } catch {
        return `${entry.name}${marker}`;
      }
    });

    if (lines.length === 0) return "(empty directory)";
    if (filtered.length > MAX_LS_ENTRIES) {
      lines.push(`\n(showing first ${MAX_LS_ENTRIES} of ${filtered.length} entries)`);
    }
    return lines.join("\n");
  },
});

/**
 * Which of `names` are gitignored in `dir`. Best-effort: outside a repo, or
 * if git is slow/absent, returns the empty set (exit 1 just means "none").
 */
function gitIgnoredNames(dir: string, names: string[]): Set<string> {
  if (names.length === 0) return new Set();
  try {
    const out = execFileSync("git", ["-C", dir, "check-ignore", "--stdin"], {
      input: names.join("\n"),
      encoding: "utf-8",
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}


// -- opening a file in its preferred application --
//
// Moved here from the `system` bag, which was dissolved. Choosing an app for a
// path is a file operation: it keys off the extension, the same way Read and
// Edit do. macOS-only — it shells out to `open -a`.
//
// BAG-23: the application names used to be one person's installed apps baked
// in (Sublime Text for .md, IINA, VS Code). On a machine without those, the
// `open -a` call fails. The categories and their matchers stay here, but the
// app NAME for each is overridable from config (`BARRY_OPEN_APPS`, a JSON
// object keyed by category), and an unmatched path falls back to the system
// default by returning null.

/** The matcher for each open category, in priority order. */
const OPEN_CATEGORIES: Array<{ category: string; match: RegExp }> = [
  { category: "pdf", match: /\.pdf$/i },
  { category: "code", match: /\.(ts|tsx|js|jsx|py|rb|go|rs|java|c|cpp|h|hpp|css|scss|json|yaml|yml|toml|sh|bash|zsh)$/i },
  { category: "markdown", match: /\.md$/i },
  { category: "url", match: /^https?:\/\//i },
  { category: "image", match: /\.(png|jpg|jpeg|gif|webp|svg|ico)$/i },
  { category: "video", match: /\.(mp4|mov|avi|mkv|webm)$/i },
  { category: "audio", match: /\.(mp3|wav|flac|m4a|aac)$/i },
];

/** Default app per category — the historical choices, now just the fallback. */
const DEFAULT_OPEN_APPS: Record<string, string> = {
  pdf: "Preview",
  code: "Visual Studio Code",
  markdown: "Sublime Text",
  url: "Google Chrome",
  image: "Preview",
  video: "IINA",
  audio: "IINA",
};

/**
 * Read the category→app overrides from `BARRY_OPEN_APPS`. A malformed value is
 * ignored (defaults stand) rather than failing every open. Exported for tests.
 */
export function openAppOverrides(raw: string | undefined = process.env.BARRY_OPEN_APPS): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The application to open `resolvedPath` with, or null to let macOS pick the
 * system default. The app name comes from config when present, else the
 * built-in default for the matched category.
 */
export function getAppForPath(resolvedPath: string, overrides = openAppOverrides()): string | null {
  for (const { category, match } of OPEN_CATEGORIES) {
    if (match.test(resolvedPath)) return overrides[category] ?? DEFAULT_OPEN_APPS[category];
  }
  return null;
}
export const open = Barry.Tool({
  namespace: "filesystem",
  access: "write",
  name: "open",
  description: "Open a file or URL with the preferred application based on file type.",
  schema: {
    path: z.string().describe("File path or URL to open"),
    app: z.string().optional().describe("Override: force a specific application (e.g., 'Safari', 'Finder')"),
  },
  handler: async ({ path: filePath, app }) => {
    const targetApp = app || getAppForPath(filePath);

    return new Promise((resolve, reject) => {
      const args = targetApp ? ["-a", targetApp, filePath] : [filePath];

      execFile("open", args, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
          return;
        }
        resolve({ opened: filePath, app: targetApp || "system default" });
      });
    });
  },
});