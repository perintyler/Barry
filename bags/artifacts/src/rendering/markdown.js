/**
 * Markdown artifacts.
 *
 * The markdown viewer itself is injected: the web app passes a themed
 * MarkdownViewer instance, the embedded viewers a lighter one. Without a
 * viewer we fall back to preformatted text rather than dumping raw HTML.
 */
export function renderMarkdown(container, doc, opts = {}) {
  const { renderMarkdownBody, classes = {} } = opts;
  const content = typeof doc.content === 'string' ? doc.content : '';

  if (renderMarkdownBody) {
    return renderMarkdownBody(container, content, doc);
  }

  const pre = document.createElement('pre');
  pre.className = classes.plain || 'artifact-viewer-plain';
  pre.textContent = content;
  container.appendChild(pre);
  return pre;
}
