import { SESSION_CHANGES_PAGE_STYLES } from "./session-changes-page-styles.js";
import { buildSessionChangesPageScript } from "./session-changes-page-script.js";

export function buildSessionChangesPage(sessionId: string, sessionName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<title>Changes - ${esc(sessionName)}</title>
<style>${SESSION_CHANGES_PAGE_STYLES}</style>
</head>
<body>

<!-- Top bar -->
<div class="top-bar">
  <a href="javascript:history.back()" aria-label="Back">&larr;</a>
  <div class="top-bar-title">
    <h1>${esc(sessionName)}</h1>
    <div class="subtitle" id="subtitle">Uncommitted Changes</div>
  </div>
  <button class="refresh-btn" onclick="loadDiff()" id="refreshBtn">Refresh</button>
</div>

<!-- Mode toggle + Stats -->
<div class="stats-bar" id="statsBar">
  <div class="mode-toggle">
    <button class="mode-btn active" id="modeUncommitted" onclick="setMode('uncommitted')">Uncommitted</button>
    <button class="mode-btn" id="modeBranch" onclick="setMode('branch')">vs <span id="baseBranchName">main</span></button>
  </div>
  <span class="stat-item"><span class="spinner"></span> Loading diff...</span>
</div>

<!-- File navigator -->
<button class="file-nav-toggle" id="fileNavToggle" onclick="toggleFileNav()">
  <span id="fileNavLabel">Files (0)</span>
  <span class="arrow">&#9660;</span>
</button>
<div class="file-nav" id="fileNav"></div>

<!-- Diff content -->
<div class="diff-container" id="diffContainer">
  <div class="loading-wrap"><span class="spinner"></span> Loading changes...</div>
</div>

<!-- Comment overlay -->
<div class="comment-overlay" id="commentOverlay" onclick="closeComment()"></div>

<!-- Comment bottom sheet -->
<div class="comment-sheet" id="commentSheet">
  <div class="sheet-handle"></div>
  <div class="sheet-context" id="sheetContext"></div>
  <div class="sheet-code" id="sheetCode"></div>
  <div class="sheet-input-wrap">
    <textarea class="sheet-input" id="commentInput" placeholder="Leave a comment..." rows="1" oninput="autoGrow(this)"></textarea>
    <button class="sheet-send" id="sendBtn" onclick="sendComment()">&#8593;</button>
  </div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>${buildSessionChangesPageScript(sessionId)}</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
