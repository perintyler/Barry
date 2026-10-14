// Extracted CSS for the session changes page. Moved verbatim from
// session-changes-page.ts to keep that module small; behavior is unchanged.
export const SESSION_CHANGES_PAGE_STYLES = `
  :root {
    --bg: #0a0a0b;
    --bg-card: #141415;
    --bg-hover: #1a1a1c;
    --bg-input: #1c1c1e;
    --border: rgba(255,255,255,0.08);
    --border-strong: rgba(255,255,255,0.15);
    --text: #e0e0e0;
    --text-dim: #888;
    --text-muted: #555;
    --blue: #3b82f6;
    --green: #22c55e;
    --green-bg: rgba(34,197,94,0.08);
    --green-border: rgba(34,197,94,0.2);
    --red: #ef4444;
    --red-bg: rgba(239,68,68,0.08);
    --red-border: rgba(239,68,68,0.2);
    --yellow: #f59e0b;
    --mono: 'SF Mono', Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  html { font-size: 16px; }

  body {
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    min-height: 100dvh;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
    overflow-x: hidden;
    -webkit-text-size-adjust: 100%;
  }

  /* Header */
  .top-bar {
    position: sticky;
    top: 0;
    z-index: 50;
    background: rgba(10,10,11,0.85);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-bottom: 1px solid var(--border);
    padding: 12px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .top-bar a {
    color: var(--text-muted);
    text-decoration: none;
    font-size: 22px;
    line-height: 1;
    padding: 4px;
    -webkit-tap-highlight-color: transparent;
  }

  .top-bar-title {
    flex: 1;
    min-width: 0;
  }

  .top-bar-title h1 {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .top-bar-title .subtitle {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 1px;
  }

  .refresh-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-dim);
    padding: 8px 12px;
    font-size: 13px;
    font-family: var(--sans);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .refresh-btn:hover { background: var(--bg-hover); border-color: var(--border-strong); }
  .refresh-btn:active { transform: scale(0.95); }

  /* Stats bar */
  .stats-bar {
    display: flex;
    gap: 16px;
    padding: 10px 16px;
    font-size: 12px;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    white-space: nowrap;
    scrollbar-width: none;
  }
  .stats-bar::-webkit-scrollbar { display: none; }
  .stat-item { display: flex; align-items: center; gap: 6px; }
  .stat-dot { width: 6px; height: 6px; border-radius: 50%; }
  .stat-dot.added { background: var(--green); }
  .stat-dot.removed { background: var(--red); }
  .stat-dot.files { background: var(--blue); }

  /* File list */
  .file-nav {
    border-bottom: 1px solid var(--border);
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .file-nav.open { max-height: 60vh; overflow-y: auto; }

  .file-nav-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 10px 16px;
    background: var(--bg-card);
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .file-nav-toggle .arrow { transition: transform 0.2s; }
  .file-nav-toggle.open .arrow { transform: rotate(180deg); }

  .file-nav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-dim);
    cursor: pointer;
    border-bottom: 1px solid var(--border);
    -webkit-tap-highlight-color: transparent;
    transition: background 0.1s;
  }
  .file-nav-item:hover { background: var(--bg-hover); }
  .file-nav-item:last-child { border-bottom: none; }
  .file-nav-item .badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 999px;
    font-weight: 600;
  }
  .badge-add { background: var(--green-bg); color: var(--green); border: 1px solid var(--green-border); }
  .badge-del { background: var(--red-bg); color: var(--red); border: 1px solid var(--red-border); }

  /* Diff content */
  .diff-container {
    padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 80px);
  }

  .file-header {
    position: sticky;
    top: 52px;
    z-index: 10;
    background: rgba(20,20,21,0.92);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
    padding: 10px 16px;
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
    -webkit-user-select: none;
  }
  .file-header:hover { background: rgba(20,20,21,0.98); }
  .file-header .file-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    flex: 1;
  }
  .file-header .file-path bdi { unicode-bidi: embed; direction: ltr; }
  .file-header .file-stats {
    display: flex;
    gap: 6px;
    font-size: 11px;
    font-weight: 500;
    flex-shrink: 0;
  }
  .file-header .file-stats .fs-add { color: var(--green); }
  .file-header .file-stats .fs-del { color: var(--red); }
  .file-header .collapse-icon {
    color: var(--text-muted);
    font-size: 10px;
    transition: transform 0.2s;
    flex-shrink: 0;
    margin-left: 4px;
  }
  .file-header.collapsed .collapse-icon { transform: rotate(-90deg); }
  .file-body { overflow: hidden; }
  .file-body.collapsed { display: none; }

  /* Hunk header */
  .hunk-header {
    background: rgba(59,130,246,0.06);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    padding: 6px 16px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--blue);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Diff lines */
  .diff-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }

  .diff-line {
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.1s;
  }

  .diff-line:active { background: rgba(59,130,246,0.1) !important; }
  .diff-line.selected { background: rgba(59,130,246,0.12) !important; }

  .diff-line td {
    vertical-align: top;
    position: relative;
  }

  .line-num {
    width: 40px;
    min-width: 40px;
    padding: 0 6px 0 8px;
    text-align: right;
    color: var(--text-muted);
    font-size: 11px;
    user-select: none;
    -webkit-user-select: none;
    white-space: nowrap;
    border-right: 1px solid var(--border);
  }

  .line-content {
    padding: 0 12px;
    white-space: pre;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .line-content::-webkit-scrollbar { display: none; }

  .diff-line.add { background: var(--green-bg); }
  .diff-line.add .line-content { color: var(--green); }
  .diff-line.del { background: var(--red-bg); }
  .diff-line.del .line-content { color: var(--red); }
  .diff-line.ctx .line-content { color: var(--text-dim); }

  .diff-line:hover { filter: brightness(1.15); }

  /* Hover comment hint */
  @media (hover: hover) {
    .diff-line:hover .line-num::before {
      content: '+';
      position: absolute;
      left: 4px;
      top: 50%;
      transform: translateY(-50%);
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--blue);
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      opacity: 0.7;
    }
  }

  /* Comment indicator */
  .has-comment .line-num { position: relative; }
  .has-comment .line-num::after {
    content: '';
    position: absolute;
    right: -1px;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 60%;
    background: var(--blue);
    border-radius: 2px;
  }

  /* Comment sheet (mobile-first bottom sheet) */
  .comment-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 100;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.2s, visibility 0.2s;
  }
  .comment-overlay.open { opacity: 1; visibility: visible; }

  .comment-sheet {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 101;
    background: var(--bg-card);
    border-top: 1px solid var(--border-strong);
    border-radius: 16px 16px 0 0;
    padding: 0 16px calc(env(safe-area-inset-bottom, 0px) + 16px);
    transform: translateY(100%);
    transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
  }
  .comment-sheet.open { transform: translateY(0); }

  .sheet-handle {
    display: flex;
    justify-content: center;
    padding: 10px 0 6px;
  }
  .sheet-handle::after {
    content: '';
    width: 36px;
    height: 4px;
    background: var(--border-strong);
    border-radius: 2px;
  }

  .sheet-context {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-muted);
    padding: 8px 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sheet-context .file { color: var(--blue); }
  .sheet-context .ln { color: var(--yellow); }

  .sheet-code {
    font-family: var(--mono);
    font-size: 11px;
    padding: 8px 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 12px;
    overflow-x: auto;
    white-space: pre;
    max-height: 80px;
    color: var(--text-dim);
    scrollbar-width: none;
  }
  .sheet-code::-webkit-scrollbar { display: none; }
  .sheet-code .prefix-add { color: var(--green); font-weight: 600; }
  .sheet-code .prefix-del { color: var(--red); font-weight: 600; }
  .sheet-code .prefix-ctx { color: var(--text-muted); }

  .sheet-input-wrap {
    display: flex;
    gap: 8px;
  }

  .sheet-input {
    flex: 1;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
    color: var(--text);
    font-family: var(--sans);
    font-size: 15px;
    outline: none;
    resize: none;
    min-height: 44px;
    max-height: 120px;
    transition: border-color 0.15s;
  }
  .sheet-input:focus { border-color: rgba(59,130,246,0.5); }
  .sheet-input::placeholder { color: var(--text-muted); }

  .sheet-send {
    width: 44px;
    height: 44px;
    border: none;
    border-radius: 10px;
    background: var(--blue);
    color: #fff;
    font-size: 18px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
    transition: all 0.15s;
  }
  .sheet-send:hover { background: #2563eb; }
  .sheet-send:active { transform: scale(0.92); }
  .sheet-send:disabled { opacity: 0.4; pointer-events: none; }

  /* Toast */
  .toast {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 64px);
    left: 50%;
    transform: translateX(-50%) translateY(-20px);
    background: var(--bg-card);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    padding: 10px 16px;
    font-size: 13px;
    color: var(--text);
    opacity: 0;
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    z-index: 200;
    max-width: 90vw;
    text-align: center;
    pointer-events: none;
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  .toast.error { border-color: var(--red); color: var(--red); }
  .toast.success { border-color: var(--green); color: var(--green); }

  /* Loading state */
  .loading-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 80px 16px;
    color: var(--text-muted);
    font-size: 14px;
    gap: 10px;
  }

  .spinner {
    width: 16px; height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--blue);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 80px 32px;
    color: var(--text-muted);
    text-align: center;
  }
  .empty-state .icon { font-size: 40px; margin-bottom: 16px; opacity: 0.5; }
  .empty-state h2 { font-size: 16px; font-weight: 600; color: var(--text-dim); margin-bottom: 8px; }
  .empty-state p { font-size: 13px; line-height: 1.5; }

  /* Desktop tweaks */
  @media (min-width: 640px) {
    .line-num { width: 52px; min-width: 52px; }
    .diff-line { font-size: 13px; }
    .hunk-header { font-size: 12px; }
    .comment-sheet {
      max-width: 560px;
      left: 50%;
      transform: translateX(-50%) translateY(100%);
      border-radius: 16px 16px 0 0;
    }
    .comment-sheet.open { transform: translateX(-50%) translateY(0); }
  }

  /* Two-column line numbers on wider screens */
  @media (min-width: 768px) {
    .line-num-old, .line-num-new {
      width: 44px;
      min-width: 44px;
      padding: 0 6px;
      text-align: right;
      color: var(--text-muted);
      font-size: 11px;
      user-select: none;
      -webkit-user-select: none;
      white-space: nowrap;
    }
    .line-num-new { border-right: 1px solid var(--border); }
  }

  /* Mode toggle */
  .mode-toggle {
    display: flex;
    background: var(--bg-hover);
    border-radius: 8px;
    padding: 2px;
    flex-shrink: 0;
  }
  .mode-btn {
    background: none;
    border: none;
    border-radius: 6px;
    padding: 4px 10px;
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .mode-btn:hover { color: var(--text-dim); }
  .mode-btn.active {
    background: var(--bg-card);
    color: var(--text);
    box-shadow: 0 1px 2px rgba(0,0,0,0.3);
  }
`;
