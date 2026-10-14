/** Extract labeled fences, preferring four backticks and respecting JSON strings when balancing three-backtick payloads. */

export function extractFence(text: string, label: string): string | null {
  const m4 = text.match(new RegExp(`\`{4,}${label}\\s*([\\s\\S]*?)\`{4,}`));
  if (m4) return m4[1].trim();

  const labelIdx = text.lastIndexOf(`\`\`\`${label}`);
  if (labelIdx === -1) return null;
  const after = text.slice(labelIdx);
  const jsonStart = after.search(/[[{]/);
  if (jsonStart === -1) return null;

  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (let i = jsonStart; i < after.length; i++) {
    const ch = after[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[" || ch === "{") stack.push(ch);
    else if (ch === "]" && stack[stack.length - 1] === "[") stack.pop();
    else if (ch === "}" && stack[stack.length - 1] === "{") stack.pop();
    if (stack.length === 0) return after.slice(jsonStart, i + 1).trim();
  }
  return null;
}
