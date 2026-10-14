/** Return fenced-code lines; examples are literal content, not document links. */
export function fencedCodeLines(lines) {
  let fence = null;
  return lines.map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && match) { fence = { character: match[1][0], length: match[1].length }; return true; }
    if (fence) {
      if (match && match[1][0] === fence.character && match[1].length >= fence.length && !match[2].trim()) fence = null;
      return true;
    }
    return false;
  });
}
