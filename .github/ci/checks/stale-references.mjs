import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { trackedPaths } from "./tracked-paths.mjs";

/** Historical review evidence describes its reviewed revision, not today's tree. */
function markdownLines(file, text) {
  if (file.startsWith("plans/review-resolution/review/") || /(?:^|\/)CHANGELOG\.md$/i.test(file)) return [];
  let fenced = false, historical = false;
  return text.split("\n").flatMap((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return []; }
    if (file.startsWith("plans/review-resolution/") && /^## /.test(line)) historical = /^## Why\s*$/.test(line);
    return fenced || historical || /^\s*>/.test(line) ? [] : [{ text: line, line: index + 1 }];
  });
}

export function referenceLines(file, text) {
  if (/\.md$/i.test(file)) return markdownLines(file, text);
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
    const comments = new Map();
    const visit = node => {
      for (const range of [...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []), ...(ts.getTrailingCommentRanges(text, node.end) ?? [])]) comments.set(range.pos, range);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return [...comments.values()].flatMap(range => {
      const first = source.getLineAndCharacterOfPosition(range.pos).line + 1;
      return text.slice(range.pos, range.end).split("\n").map((value, index) => ({ text: value, line: first + index }));
    });
  }
  if (/\.(?:ya?ml|sh|swift)$/.test(file)) return text.split("\n").flatMap((line, index) => /^\s*(?:#|\/\/)/.test(line) ? [{ text: line, line: index + 1 }] : []);
  return [];
}

export function declaredLabels(file, text) {
  const labels = new Set();
  if (!/\.md$/i.test(file)) return labels;
  for (const { text: line } of markdownLines(file, text)) {
    const invariant = /\*\*Invariant (I\d+)\s*[—:]/.exec(line);
    const heading = /^\s*#{1,6}\s+((?:WP-[A-Z]*\d+|AP-\d+))\b/.exec(line);
    if (invariant) labels.add(invariant[1]);
    if (heading) labels.add(heading[1]);
  }
  return labels;
}

export function referenceProblems(file, lines, { exists, commits, labels = new Set() }) {
  const problems = [];
  for (const { text: original, line } of lines) {
    const text = original.replace(/https?:\/\/[^\s)>]+/g, "");
    const report = message => problems.push({ file, line, message });
    for (const match of text.matchAll(/\b(?:research\s+[RE]\d+(?:\/[RE]?\d+)*|ruling\s*§\s*\d+(?:\.\d+)*|astra[- ]review(?:\s+[A-Z]+\d+(?:-[A-Z]?\d+)?)?)\b/gi)) report(`Untracked historical citation: ${match[0]}`);
    for (const match of text.matchAll(/\b(?:invariant\s+I\d+|WP-[A-Z]*\d+|AP-\d+)\b/gi)) {
      const label = match[0].replace(/^invariant\s+/i, "").toUpperCase();
      if (!labels.has(label)) report(`Untracked historical citation: ${match[0]}`);
    }
    const paths = new Set([...text.matchAll(/(?:^|[\s`("'])((?:sdk|adapters|bags|cli|packages|plans|docs|config|engine|\.github|\.config|src)\/[\w./-]+|barry-history(?:\/[\w./-]+)?|AGENTS\.md)/g)].map(match => match[1].replace(/[.,]+$/, "").replace(/\/$/, "")));
    for (const candidate of paths) {
      if (!exists(file, candidate)) report(`Repository reference does not exist: ${candidate}`);
    }
    for (const match of text.matchAll(/(?<![\w.-])[0-9a-f]{7,40}(?![\w.-])/gi)) {
      const token = match[0].toLowerCase();
      // Decimal timestamps and quantities are not commit references.
      if (!/[a-f]/.test(token)) continue;
      if (!commits.some(commit => commit.startsWith(token))) report(`Commit reference is absent from git history: ${token}`);
    }
  }
  return problems;
}

export function checkReferences(root = process.cwd()) {
  const tracked = trackedPaths(root);
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  const commits = execFileSync("git", ["rev-list", "--all"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim().split("\n");
  const labels = new Set(files.filter(file => /\.md$/i.test(file) && tracked(path.join(root, file)))
    .flatMap(file => [...declaredLabels(file, readFileSync(path.join(root, file), "utf8"))]));
  const exists = (file, candidate) => {
    const generatedSource = candidate.replace(/\/dist(?=\/|$)/, "/src");
    const variants = [candidate, candidate.replace(/\.js$/, ".ts"), candidate.replace(/\.mjs$/, ".mts")];
    if (generatedSource !== candidate) variants.push(generatedSource, generatedSource.replace(/\.js$/, ".ts"), generatedSource.replace(/\.mjs$/, ".mts"));
    const roots = [root];
    {
      for (let directory = path.dirname(path.join(root, file)); directory.startsWith(root) && directory !== root; directory = path.dirname(directory)) roots.push(directory);
    }
    return roots.some(directory => variants.some(value => tracked(path.resolve(directory, value))));
  };
  return files.flatMap(file => {
    if (!tracked(path.join(root, file))) return [];
    if (file.startsWith(".github/ci/vendor/") || /(?:^|\/)(?:dist|generated|vendor)\//.test(file) || /\.generated\./.test(file)) return [];
    if (!/\.(?:md|[cm]?[jt]sx?|ya?ml|sh|swift)$/.test(file)) return [];
    return referenceProblems(file, referenceLines(file, readFileSync(path.join(root, file), "utf8")), { exists, commits, labels });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkReferences();
  for (const problem of problems) console.error(`${problem.file}:${problem.line}: ${problem.message}`);
  if (problems.length) process.exitCode = 1;
  else console.log("Current comment and Markdown references are valid; no allowlist.");
}
