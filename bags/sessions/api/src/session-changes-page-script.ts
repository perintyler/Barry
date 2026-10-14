// Extracted client-side script for the session changes page. Moved verbatim
// from session-changes-page.ts (still a template literal so the inner escape
// sequences such as \\n and \` are preserved exactly). Behavior is unchanged.
export function buildSessionChangesPageScript(sessionId: string): string {
  return `
const SESSION_ID = ${JSON.stringify(sessionId)};
let diffData = null;
let commentCtx = null; // { file, line, code, type }
let currentMode = 'uncommitted';

// ─── Mode Toggle ───────────────────────────────────────────

function setMode(mode) {
  if (mode === currentMode) return;
  currentMode = mode;
  document.getElementById('modeUncommitted').classList.toggle('active', mode === 'uncommitted');
  document.getElementById('modeBranch').classList.toggle('active', mode === 'branch');
  // Update subtitle based on whether we're on main branch
  let subtitle;
  if (mode === 'branch') {
    if (diffData?.onMainBranch) {
      subtitle = 'Uncommitted Changes (on main)';
    } else {
      subtitle = 'Changes vs ' + (diffData?.baseBranch || 'main');
    }
  } else {
    subtitle = 'Uncommitted Changes';
  }
  document.getElementById('subtitle').textContent = subtitle;
  loadDiff();
}

// ─── Diff Loading ──────────────────────────────────────────

async function loadDiff() {
  const btn = document.getElementById('refreshBtn');
  btn.textContent = '...';
  btn.disabled = true;

  try {
    const modeParam = currentMode !== 'uncommitted' ? '?mode=' + currentMode : '';
    const res = await fetch('/sessions/' + SESSION_ID + '/diff' + modeParam);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    diffData = data;
    if (data.baseBranch) {
      document.getElementById('baseBranchName').textContent = data.baseBranch;
    }
    renderDiff(data.diff);
  } catch (err) {
    document.getElementById('diffContainer').innerHTML =
      '<div class="empty-state"><div class="icon">!</div><h2>Error loading diff</h2><p>' + esc(err.message) + '</p></div>';
  }

  btn.textContent = 'Refresh';
  btn.disabled = false;
}

function parseDiff(raw) {
  if (!raw || !raw.trim()) return [];

  const files = [];
  let currentFile = null;
  let currentHunk = null;

  for (const line of raw.split('\\n')) {
    if (line.startsWith('diff --git') || line.startsWith('diff --no-index')) {
      if (currentFile) files.push(currentFile);
      currentFile = { oldName: '', newName: '', hunks: [], additions: 0, deletions: 0 };
      currentHunk = null;
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith('--- ')) {
      currentFile.oldName = line.slice(4).replace(/^a\\//, '').replace(/^\\/dev\\/null$/, '/dev/null');
      continue;
    }
    if (line.startsWith('+++ ')) {
      currentFile.newName = line.slice(4).replace(/^b\\//, '').replace(/^\\/dev\\/null$/, '/dev/null');
      continue;
    }
    if (line.startsWith('index ') || line.startsWith('new file') ||
        line.startsWith('deleted file') || line.startsWith('old mode') ||
        line.startsWith('new mode') || line.startsWith('similarity') ||
        line.startsWith('rename from') || line.startsWith('rename to') ||
        line.startsWith('Binary files')) {
      continue;
    }

    const hunkMatch = line.match(/^@@\\s+-?(\\d+)(?:,(\\d+))?\\s+\\+?(\\d+)(?:,(\\d+))?\\s+@@(.*)/);
    if (hunkMatch) {
      currentHunk = {
        header: line,
        oldStart: parseInt(hunkMatch[1], 10),
        newStart: parseInt(hunkMatch[3], 10),
        context: hunkMatch[5] || '',
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({ type: 'add', content: line.slice(1) });
        currentFile.additions++;
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ type: 'del', content: line.slice(1) });
        currentFile.deletions++;
      } else if (line.startsWith(' ') || line === '') {
        currentHunk.lines.push({ type: 'ctx', content: line.slice(1) || '' });
      } else if (line.startsWith('\\\\')) {
        // "No newline at end of file"
        continue;
      }
    }
  }

  if (currentFile) files.push(currentFile);
  return files;
}

function renderModeToggle() {
  const baseBranch = diffData?.baseBranch || 'main';
  return '<div class="mode-toggle">' +
    '<button class="mode-btn' + (currentMode === 'uncommitted' ? ' active' : '') + '" onclick="setMode('uncommitted')">Uncommitted</button>' +
    '<button class="mode-btn' + (currentMode === 'branch' ? ' active' : '') + '" onclick="setMode('branch')">vs ' + baseBranch + '</button>' +
    '</div>';
}

function renderDiff(raw) {
  const files = parseDiff(raw);

  if (files.length === 0) {
    let emptyMsg, emptyDesc;
    if (currentMode === 'branch') {
      if (diffData?.onMainBranch) {
        emptyMsg = 'No uncommitted changes';
        emptyDesc = 'Working tree is clean on main';
      } else {
        emptyMsg = 'No changes vs ' + (diffData?.baseBranch || 'main');
        emptyDesc = 'Branch matches ' + (diffData?.baseBranch || 'main');
      }
    } else {
      emptyMsg = 'No uncommitted changes';
      emptyDesc = 'Working tree is clean';
    }
    document.getElementById('diffContainer').innerHTML =
      '<div class="empty-state"><div class="icon">&#10003;</div><h2>' + emptyMsg + '</h2><p>' + emptyDesc + '</p></div>';
    document.getElementById('statsBar').innerHTML =
      renderModeToggle() + '<span class="stat-item" style="color:var(--green)">Clean</span>';
    document.getElementById('fileNavLabel').textContent = 'Files (0)';
    document.getElementById('fileNav').innerHTML = '';
    return;
  }

  // Stats
  let totalAdd = 0, totalDel = 0;
  files.forEach(f => { totalAdd += f.additions; totalDel += f.deletions; });

  document.getElementById('statsBar').innerHTML =
    renderModeToggle() +
    '<span class="stat-item"><span class="stat-dot files"></span>' + files.length + ' file' + (files.length !== 1 ? 's' : '') + '</span>' +
    '<span class="stat-item"><span class="stat-dot added"></span>+' + totalAdd + '</span>' +
    '<span class="stat-item"><span class="stat-dot removed"></span>-' + totalDel + '</span>';

  // File nav
  document.getElementById('fileNavLabel').textContent = 'Files (' + files.length + ')';
  document.getElementById('fileNav').innerHTML = files.map((f, i) =>
    '<div class="file-nav-item" onclick="scrollToFile(' + i + ')">' +
      '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left"><bdi>' + esc(displayName(f)) + '</bdi></span>' +
      (f.additions > 0 ? '<span class="badge badge-add">+' + f.additions + '</span>' : '') +
      (f.deletions > 0 ? '<span class="badge badge-del">-' + f.deletions + '</span>' : '') +
    '</div>'
  ).join('');

  // Render files
  let html = '';
  files.forEach((file, fi) => {
    const fname = displayName(file);
    html += '<div id="file-' + fi + '">';
    html += '<div class="file-header" onclick="toggleFile(' + fi + ')">';
    html += '<span class="file-path"><bdi>' + esc(fname) + '</bdi></span>';
    html += '<span class="file-stats">';
    if (file.additions > 0) html += '<span class="fs-add">+' + file.additions + '</span>';
    if (file.deletions > 0) html += '<span class="fs-del">-' + file.deletions + '</span>';
    html += '</span>';
    html += '<span class="collapse-icon">&#9660;</span>';
    html += '</div>';
    html += '<div class="file-body" id="filebody-' + fi + '">';

    file.hunks.forEach(hunk => {
      html += '<div class="hunk-header">' + esc(hunk.header) + '</div>';
      html += '<table class="diff-table">';

      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;

      hunk.lines.forEach(line => {
        let lineNum = '';
        let ln = 0;
        if (line.type === 'add') { ln = newLine; lineNum = String(newLine++); }
        else if (line.type === 'del') { ln = oldLine; lineNum = String(oldLine++); }
        else { ln = newLine; lineNum = String(newLine++); oldLine++; }

        const escaped = esc(line.content);
        html += '<tr class="diff-line ' + line.type + '" data-file="' + esc(fname) + '" data-line="' + ln + '" data-type="' + line.type + '" onclick="openComment(this)">';
        html += '<td class="line-num">' + lineNum + '</td>';
        html += '<td class="line-content">' + escaped + '</td>';
        html += '</tr>';
      });

      html += '</table>';
    });

    html += '</div>'; // file-body
    html += '</div>'; // file wrapper
  });

  document.getElementById('diffContainer').innerHTML = html;
}

function displayName(f) {
  if (f.newName && f.newName !== '/dev/null') return f.newName;
  return f.oldName || '(unknown)';
}

// ─── File Navigation ───────────────────────────────────────

function toggleFileNav() {
  const nav = document.getElementById('fileNav');
  const toggle = document.getElementById('fileNavToggle');
  const isOpen = nav.classList.toggle('open');
  toggle.classList.toggle('open', isOpen);
}

function scrollToFile(idx) {
  const el = document.getElementById('file-' + idx);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('fileNav').classList.remove('open');
  document.getElementById('fileNavToggle').classList.remove('open');
}

// ─── Comments ──────────────────────────────────────────────

function openComment(tr) {
  const file = tr.dataset.file;
  const line = tr.dataset.line;
  const type = tr.dataset.type;
  const code = tr.querySelector('.line-content')?.textContent || '';

  commentCtx = { file, line, code, type };

  // Highlight selected line
  document.querySelectorAll('.diff-line.selected').forEach(el => el.classList.remove('selected'));
  tr.classList.add('selected');

  document.getElementById('sheetContext').innerHTML =
    '<span class="file">' + esc(file) + '</span> : <span class="ln">L' + line + '</span>';

  const prefixClass = type === 'add' ? 'prefix-add' : type === 'del' ? 'prefix-del' : 'prefix-ctx';
  const prefixChar = type === 'add' ? '+' : type === 'del' ? '-' : ' ';
  document.getElementById('sheetCode').innerHTML =
    '<span class="' + prefixClass + '">' + prefixChar + '</span>' + esc(code);

  document.getElementById('commentOverlay').classList.add('open');
  document.getElementById('commentSheet').classList.add('open');

  const input = document.getElementById('commentInput');
  input.value = '';
  input.style.height = 'auto';
  setTimeout(() => input.focus(), 100);
}

function closeComment() {
  document.getElementById('commentOverlay').classList.remove('open');
  document.getElementById('commentSheet').classList.remove('open');
  document.querySelectorAll('.diff-line.selected').forEach(el => el.classList.remove('selected'));
  commentCtx = null;
}

async function sendComment() {
  if (!commentCtx) return;
  const input = document.getElementById('commentInput');
  const text = input.value.trim();
  if (!text) return;

  const btn = document.getElementById('sendBtn');
  btn.disabled = true;

  const messageContent = [
    'Code review comment on \`' + commentCtx.file + '\` line ' + commentCtx.line + ':',
    '',
    '> \`\`\`',
    '> ' + (commentCtx.type === 'add' ? '+' : commentCtx.type === 'del' ? '-' : ' ') + commentCtx.code,
    '> \`\`\`',
    '',
    text,
  ].join('\\n');

  try {
    const res = await fetch('/sessions/' + SESSION_ID + '/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: messageContent }),
    });
    const data = await res.json();

    if (data.ok) {
      // Mark the line
      const rows = document.querySelectorAll('.diff-line[data-file="' + CSS.escape(commentCtx.file) + '"][data-line="' + commentCtx.line + '"]');
      rows.forEach(r => r.classList.add('has-comment'));

      closeComment();
      showToast('Comment sent', 'success');
    } else {
      showToast(data.error || 'Failed to send', 'error');
    }
  } catch (err) {
    showToast('Network error', 'error');
  }

  btn.disabled = false;
}

// Handle Enter to send (Shift+Enter for newline)
document.getElementById('commentInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendComment();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeComment();
});

// ─── File Collapse ─────────────────────────────────────────

function toggleFile(idx) {
  const header = document.querySelector('#file-' + idx + ' .file-header');
  const body = document.getElementById('filebody-' + idx);
  if (!header || !body) return;
  header.classList.toggle('collapsed');
  body.classList.toggle('collapsed');
}

// ─── Helpers ───────────────────────────────────────────────

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + (type || '');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ─── Init ──────────────────────────────────────────────────

loadDiff();

// Refresh on visibility change (e.g., switching back to tab)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadDiff();
});
`;
}
