// ══ FILEBLOCKS.JS ════════════════════════════════════════════
// Streaming-aware file-block parser and renderer for Jarvis chat.
//
// Adds support for model-emitted fenced file blocks:
//
//   ```filename.ext
//   ...file contents...
//   ```
//
// During streaming: the fence content is hidden; a "generating…"
// pill is shown instead.  Once streaming ends: the pill becomes a
// collapsible file card with a download button.
//
// Load order in index.html:
//   … → settings.js → corrector.js → fileblocks.js → chat.js → …
//
// No modifications to chat.js / main.js / api.js are required.
// This file monkey-patches updateBubble (defined in chat.js) after
// chat.js loads, so it must come BEFORE chat.js in the script list.
// The patch is applied via a DOMContentLoaded / post-load hook that
// waits until chat.js has run and updateBubble exists on the window.
// ─────────────────────────────────────────────────────────────────

// ── MIME map (extension → MIME type for download) ────────────
const _FB_MIME = {
  // Text / code
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  ts: 'text/typescript', tsx: 'text/typescript',
  jsx: 'text/javascript',
  py: 'text/x-python', rb: 'text/x-ruby', php: 'text/x-php',
  java: 'text/x-java-source', c: 'text/x-csrc', cpp: 'text/x-c++src',
  cs: 'text/x-csharp', go: 'text/x-go', rs: 'text/x-rustsrc',
  sh: 'text/x-sh', bash: 'text/x-sh', zsh: 'text/x-sh',
  ps1: 'text/x-powershell',
  sql: 'text/x-sql', r: 'text/x-r',
  swift: 'text/x-swift', kt: 'text/x-kotlin', scala: 'text/x-scala',
  lua: 'text/x-lua', pl: 'text/x-perl',
  // Data
  json: 'application/json', jsonl: 'application/x-ndjson',
  xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
  toml: 'application/toml', ini: 'text/plain', env: 'text/plain',
  csv: 'text/csv', tsv: 'text/tab-separated-values',
  // Config / docs
  svg: 'image/svg+xml', diff: 'text/x-diff', patch: 'text/x-diff',
  dockerfile: 'text/plain', makefile: 'text/plain',
  gitignore: 'text/plain', editorconfig: 'text/plain',
};

function _fbMime(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return _FB_MIME[ext] || 'text/plain';
}

// ── Extension → language label for the header badge ──────────
const _FB_LANG = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX',
  py: 'Python', rb: 'Ruby', php: 'PHP', java: 'Java',
  c: 'C', cpp: 'C++', cs: 'C#', go: 'Go', rs: 'Rust',
  sh: 'Shell', bash: 'Bash', zsh: 'Zsh', ps1: 'PowerShell',
  sql: 'SQL', r: 'R', swift: 'Swift', kt: 'Kotlin',
  scala: 'Scala', lua: 'Lua', pl: 'Perl',
  html: 'HTML', htm: 'HTML', css: 'CSS',
  json: 'JSON', jsonl: 'JSONL', xml: 'XML',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML', csv: 'CSV',
  tsv: 'TSV', md: 'Markdown', markdown: 'Markdown',
  svg: 'SVG', diff: 'Diff', patch: 'Patch',
  txt: 'Text',
};

function _fbLang(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return _FB_LANG[ext] || ext.toUpperCase() || 'File';
}

// ── File icon SVG (generic document) ─────────────────────────
const _FB_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
  <polyline points="14 2 14 8 20 8"/>
  <line x1="16" y1="13" x2="8" y2="13"/>
  <line x1="16" y1="17" x2="8" y2="17"/>
</svg>`;

const _FB_DL_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="7 10 12 15 17 10"/>
  <line x1="12" y1="15" x2="12" y2="3"/>
</svg>`;

const _FB_COPY_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
</svg>`;

const _FB_CHEVRON = `<svg class="fb-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
  <path d="M6 9l6 6 6-6"/>
</svg>`;

// ── Inject CSS once ───────────────────────────────────────────
(function _injectFileblocksCSS() {
  if (document.getElementById('_fileblocks-css')) return;
  const s = document.createElement('style');
  s.id = '_fileblocks-css';
  s.textContent = `
    /* ── Generating pill (shown while streaming) ── */
    .fb-generating-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px 3px 7px;
      border-radius: 20px;
      border: 1px solid var(--border);
      background: var(--bg2);
      color: var(--text2);
      font-size: 0.8em;
      font-family: var(--font-mono, monospace);
      margin: 4px 0;
      vertical-align: middle;
    }
    .fb-generating-pill .fb-pill-spinner {
      width: 8px; height: 8px;
      border: 1.5px solid var(--text2);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: fb-spin 0.7s linear infinite;
      flex-shrink: 0;
    }
    .fb-generating-pill .fb-pill-lines {
      font-variant-numeric: tabular-nums;
      color: var(--accent);
      font-weight: 600;
    }
    @keyframes fb-spin { to { transform: rotate(360deg); } }

    /* ── Finished file card ── */
    .fb-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      margin: 6px 0;
      font-size: 0.85em;
    }
    .fb-card-header {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 10px;
      background: var(--bg2);
      cursor: pointer;
      user-select: none;
      color: var(--text2);
    }
    .fb-card-header:hover { background: var(--bg3, var(--bg2)); }
    .fb-card-filename {
      flex: 1;
      font-family: var(--font-mono, monospace);
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .fb-card-lang {
      font-size: 0.78em;
      padding: 1px 6px;
      border-radius: 10px;
      background: oklch(from var(--accent) l c h / 12%);
      color: var(--accent);
      white-space: nowrap;
    }
    .fb-card-lines {
      font-size: 0.78em;
      color: var(--text2);
      white-space: nowrap;
      opacity: 0.75;
    }
    .fb-card-actions {
      display: flex;
      align-items: center;
      gap: 3px;
      margin-left: 4px;
    }
    .fb-action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px; height: 22px;
      border-radius: 5px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--text2);
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s, background 0.15s;
      flex-shrink: 0;
    }
    .fb-action-btn:hover {
      color: var(--text);
      border-color: var(--border);
      background: var(--bg);
    }
    .fb-action-btn.copied { color: var(--green); }
    .fb-card-chevron-wrap { display: flex; align-items: center; }
    .fb-chevron {
      transition: transform 0.2s ease;
      color: var(--text2);
    }
    .fb-card.fb-open .fb-chevron { transform: rotate(180deg); }

    /* ── Preview body ── */
    .fb-card-body {
      display: none;
      max-height: 200px;
      overflow-y: auto;
      background: var(--bg);
      border-top: 1px solid var(--border);
    }
    .fb-card.fb-open .fb-card-body { display: block; }
    .fb-card-body pre {
      margin: 0;
      padding: 10px 12px;
      font-family: var(--font-mono, monospace);
      font-size: 0.9em;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text);
      background: transparent;
      border: none;
      border-radius: 0;
    }
    /* Suppress the code-copy-btn that chat.js injects into .fb-card-body pre */
    .fb-card-body pre .code-copy-btn { display: none !important; }
  `;
  document.head.appendChild(s);
})();

// ─────────────────────────────────────────────────────────────
// FileBlockParser
// ─────────────────────────────────────────────────────────────
// Parses < jarvis_file name="filename.ext" >…< /jarvis_file > tags
// emitted by the model.  Uses a proprietary tag so there is zero
// conflict with the model's trained Markdown/code-fence behaviour.
//
// Public API:
//   parser.process(reply, streaming)
//     → { display, blocks }
//       display  — text with tag regions replaced by placeholder tokens,
//                  safe to pass to renderMarkdownWithLatex
//       blocks   — Map<placeholder → { filename, content, complete }>
//
// Streaming behaviour:
//   • As soon as < jarvis_file name="…" > is seen the content is buffered
//     and a placeholder is emitted instead, so the raw tag/content never
//     reaches the Markdown renderer.
//   • A "generating…" pill occupies the placeholder slot while streaming.
//   • On close tag (or end-of-stream for the final render) the pill is
//     swapped for a collapsed file card.
// ─────────────────────────────────────────────────────────────

// Opening tag — captures the filename attribute.
// Allows single or double quotes, optional whitespace.
const _FB_OPEN_RE  = /<jarvis_file\s+name=["']([^"']+)["']\s*>/;

// Closing tag (literal string — faster than regex for inner search)
const _FB_CLOSE    = '</jarvis_file>';

// Partial-open detector: any prefix of <jarvis_file at the tail of the
// stream that hasn't been confirmed as a real open tag yet.
const _FB_PARTIAL_RE = /<(?:j(?:a(?:r(?:v(?:i(?:s(?:_(?:f(?:i(?:l(?:e)?)?)?)?)?)?)?)?)?)?)?$/;

class FileBlockParser {
  constructor() {
    this._blocks  = new Map(); // placeholder → { filename, content, complete }
    this._counter = 0;
  }

  _ph(idx) { return `\x02FILEBLOCK${idx}\x03`; }

  process(reply, streaming) {
    let display   = '';
    let remaining = reply;

    while (remaining.length > 0) {
      const openMatch = _FB_OPEN_RE.exec(remaining);

      if (!openMatch) {
        // No (more) file tags.  During streaming, hold back any partial
        // <jarvis_file prefix at the tail so it doesn't leak into Markdown.
        if (streaming) {
          const held = _FB_holdTail(remaining);
          display   += held.safe;
          remaining  = held.held;
        } else {
          display += remaining;
        }
        break;
      }

      // Safe prose before the opening tag
      display   += remaining.slice(0, openMatch.index);
      remaining  = remaining.slice(openMatch.index + openMatch[0].length);

      const filename = openMatch[1].trim();
      const closeIdx = remaining.indexOf(_FB_CLOSE);

      if (closeIdx === -1) {
        // Tag is still open — buffer partial content
        const idx   = this._findOrCreateBlock(filename);
        const ph    = this._ph(idx);
        const block = this._blocks.get(ph);
        block.content  = remaining;
        block.complete = false;
        remaining = '';
        display  += ph;
      } else {
        // Complete block
        const content = remaining.slice(0, closeIdx);
        remaining = remaining.slice(closeIdx + _FB_CLOSE.length);

        const idx   = this._findOrCreateBlock(filename);
        const ph    = this._ph(idx);
        const block = this._blocks.get(ph);
        block.content  = content;
        block.complete = true;
        display += ph;
      }
    }

    return { display, blocks: this._blocks };
  }

  _findOrCreateBlock(filename) {
    for (const [ph, block] of this._blocks) {
      if (block.filename === filename && !block.complete) {
        return parseInt(ph.replace('\x02FILEBLOCK', '').replace('\x03', ''), 10);
      }
    }
    const idx = this._counter++;
    this._blocks.set(this._ph(idx), { filename, content: '', complete: false });
    return idx;
  }

  reset() {
    this._blocks  = new Map();
    this._counter = 0;
  }
}

// Hold back a partial <jarvis_file tag at the very tail of the streamed
// text so it never reaches the Markdown renderer mid-token.
function _FB_holdTail(text) {
  const m = _FB_PARTIAL_RE.exec(text);
  if (m) return { safe: text.slice(0, m.index), held: m[0] };
  return { safe: text, held: '' };
}

// ─────────────────────────────────────────────────────────────
// DOM helpers — build the generating pill and the finished card
// ─────────────────────────────────────────────────────────────

function _fbBuildPill(filename, lineCount = 0) {
  const pill = document.createElement('span');
  pill.className = 'fb-generating-pill';
  const lineLabel = lineCount > 0
    ? `generating… <span class="fb-pill-lines">${lineCount} line${lineCount === 1 ? '' : 's'}</span>`
    : `generating…`;
  pill.innerHTML =
    `<span class="fb-pill-spinner"></span>` +
    `${_FB_ICON} <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"` +
    ` title="${_esc(filename)}">${_esc(filename)}</span>` +
    `<span style="font-size:0.85em;opacity:0.7;">${lineLabel}</span>`;
  return pill;
}

function _fbBuildCard(filename, content) {
  const card = document.createElement('div');
  card.className = 'fb-card';

  const lang = _fbLang(filename);

  const header = document.createElement('div');
  header.className = 'fb-card-header';
  header.innerHTML =
    `${_FB_ICON}` +
    `<span class="fb-card-filename" title="${_esc(filename)}">${_esc(filename)}</span>` +
    `<span class="fb-card-lang">${_esc(lang)}</span>` +
    `<span class="fb-card-lines">(${content.split('\n').length} lines)</span>` +
    `<span class="fb-card-actions"></span>` +
    `<span class="fb-card-chevron-wrap">${_FB_CHEVRON}</span>`;

  // ── Copy button ───────────────────────────────────────────
  const copyBtn = document.createElement('button');
  copyBtn.className = 'fb-action-btn';
  copyBtn.title = 'Copy contents';
  copyBtn.innerHTML = _FB_COPY_ICON;
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(content); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = content;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    copyBtn.classList.add('copied');
    setTimeout(() => copyBtn.classList.remove('copied'), 1500);
  });

  // ── Download button ───────────────────────────────────────
  const dlBtn = document.createElement('button');
  dlBtn.className = 'fb-action-btn';
  dlBtn.title = `Download ${filename}`;
  dlBtn.innerHTML = _FB_DL_ICON;
  dlBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const blob = new Blob([content], { type: _fbMime(filename) });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  header.querySelector('.fb-card-actions').append(copyBtn, dlBtn);

  // ── Preview body ──────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'fb-card-body';
  const pre  = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = content;
  pre.appendChild(code);
  body.appendChild(pre);

  // ── Toggle collapse ───────────────────────────────────────
  header.addEventListener('click', () => card.classList.toggle('fb-open'));

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

function _esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────
// Post-render DOM pass: replace placeholder text nodes with cards/pills
// ─────────────────────────────────────────────────────────────

function _fbApplyToDOM(bubbleEl, blocks, streaming) {
  // Walk all text nodes in the bubble, look for placeholder tokens,
  // and replace them with the appropriate element.
  _fbReplaceTextNodes(bubbleEl, blocks, streaming);
}

function _fbReplaceTextNodes(root, blocks, streaming) {
  // Collect text nodes first (avoid mutating during traversal)
  const textNodes = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) textNodes.push(n);

  for (const tn of textNodes) {
    const val = tn.nodeValue || '';
    // Quick bail if no placeholder present
    if (!val.includes('\x02FILEBLOCK')) continue;

    // Split on any placeholder token
    const parts = val.split(/(\x02FILEBLOCK\d+\x03)/);
    if (parts.length <= 1) continue;

    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (blocks.has(part)) {
        const { filename, content, complete } = blocks.get(part);
        if (streaming && !complete) {
          const lineCount = content ? content.split('\n').length : 0;
          frag.appendChild(_fbBuildPill(filename, lineCount));
        } else {
          frag.appendChild(_fbBuildCard(filename, content));
        }
      } else {
        frag.appendChild(document.createTextNode(part));
      }
    }
    tn.parentNode.replaceChild(frag, tn);
  }
}

// ─────────────────────────────────────────────────────────────
// Integration
// ─────────────────────────────────────────────────────────────
// Patches updateBubble and addBubble so that:
//   • Live streaming (no backend): file cards appear via updateBubble.
//   • Restored history: addBubble re-renders assistant messages through
//     the file-block processor so cards are rebuilt without stored metadata.
//   • Tool summaries: reconstructed on restore from chatHistory.
//
// Backend chat routing is handled entirely by chat.js (generateChatBackend).
// ─────────────────────────────────────────────────────────────

// Per-bubble parser registry (keyed by bubble DOM element)
const _fbParsers = new WeakMap();

function _fbGetParser(bubble) {
  if (!_fbParsers.has(bubble)) _fbParsers.set(bubble, new FileBlockParser());
  return _fbParsers.get(bubble);
}

// ── Core file-block renderer ──────────────────────────────────
// Shared by both updateBubble and addBubble patches.
function _fbRenderInto(origUpdateFn, bubble, content, streaming) {
  const parser = _fbGetParser(bubble);
  if (!streaming) parser.reset();
  const { display, blocks } = parser.process(content, streaming);
  origUpdateFn.call(null, bubble, display, streaming);
  // Restore _rawContent to the original unprocessed text so the bubble
  // copy button copies the real content, not the placeholder tokens.
  bubble._rawContent = content;
  if (blocks.size > 0) _fbApplyToDOM(bubble, blocks, streaming);
}

// ── Patch: updateBubble ───────────────────────────────────────
function _fbPatchedUpdateBubble(origFn) {
  return function updateBubble(bubble, content, streaming = true) {
    _fbRenderInto(origFn, bubble, content, streaming);
  };
}

// ── Patch: addBubble ──────────────────────────────────────────
// addBubble builds the DOM and renders assistant content directly via
// renderMarkdownWithLatex — bypassing updateBubble entirely.
// We intercept it: let the original run (it builds the wrapper, labels,
// copy-btn etc.), then immediately re-render the bubble's content
// through our file-block processor.
function _fbPatchedAddBubble(origFn) {
  return function addBubble(role, content, streaming = false, imageUrl = null, attachmentInfo = null) {
    const bubble = origFn.call(this, role, content, streaming, imageUrl, attachmentInfo);
    // Process file blocks for both assistant and user bubbles.
    // User bubbles contain <jarvis_file> blocks when text files are attached.
    if (content && (role === 'assistant' || (role === 'user' && content.includes('<jarvis_file')))) {
      _fbRenderInto(_fbOrigUpdateBubble, bubble, content, streaming);
    }
    return bubble;
  };
}

// ── Tool-summary reconstruction on restore ────────────────────
// chatHistory contains the full tool-call round-trip as stored messages:
//   { role:'assistant', tool_calls:[…] }  — the model's invocation
//   { role:'tool', content:'…' }          — each tool result
//   { role:'assistant', content:'…' }     — the final reply (has its own bubble)
//
// On restore, restoreChat() renders ONE bubble per chatHistory entry
// (skipping role:'tool' entries that have no visible content). We hook
// into the addBubble patch above: after all bubbles are in the DOM we
// do a single pass over chatHistory to find assistant→tool→assistant
// sequences and attach a reconstructed summary to the right bubble.
//
// The summary DOM is identical to the live _appendToolSummary output,
// so no new styles are needed.

function _fbReconstructToolSummaries() {
  // We need chatHistory and _appendToolSummary to exist (both from chat.js).
  if (typeof chatHistory === 'undefined' || typeof _appendToolSummary === 'undefined') return;

  // Gather all assistant bubbles in DOM order.
  const bubbles = Array.from(
    document.querySelectorAll('#chat-messages .msg.assistant .msg-bubble')
  );
  if (!bubbles.length) return;

  // Walk chatHistory; group tool-call rounds.
  // Each round is: [assistant/tool_calls msg, ...tool result msgs]
  // followed eventually by a plain assistant msg (the final reply).
  let bubbleIdx = 0; // which assistant bubble we're aligned to

  // Build a flattened list of history entries with their indices so we can
  // look ahead/behind cheaply.
  const hist = chatHistory;

  for (let i = 0; i < hist.length; i++) {
    const msg = hist[i];

    // Skip non-assistant and assistant messages without tool_calls
    if (msg.role !== 'assistant') continue;
    if (!msg.tool_calls?.length) {
      // Plain assistant message — advance our bubble pointer.
      bubbleIdx++;
      continue;
    }

    // This assistant message has tool_calls — collect the following tool results.
    const callsAndResults = [];
    let j = i + 1;
    while (j < hist.length && hist[j].role === 'tool') {
      const toolMsg = hist[j];
      // Match back to the tool_call entry by position (same order as pushes).
      const tc = msg.tool_calls[callsAndResults.length] || {};
      const fnName = tc.function?.name || tc.name || '(tool)';
      const fnArgs = (() => {
        try {
          const raw = tc.function?.arguments ?? tc.arguments ?? {};
          return typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch { return {}; }
      })();
      callsAndResults.push({
        tc:     { function: { name: fnName, arguments: fnArgs } },
        result: toolMsg.content || '',
        error:  false
      });
      j++;
    }

    if (!callsAndResults.length) { bubbleIdx++; continue; }

    // The tool-summary is attached to the bubble that PRECEDES the final reply.
    // On the live path that's the first bubble of the round (which may be hidden
    // when reply was empty). On restore, restoreChat skips role:'tool' entries,
    // so the bubble sequence is just the assistant messages in order.
    // The summary belongs on the bubble at current bubbleIdx.
    const targetBubble = bubbles[bubbleIdx];
    if (targetBubble && !targetBubble.parentElement.querySelector('.tool-calls-summary')) {
      _appendToolSummary(targetBubble, callsAndResults);
    }

    // Advance past the tool messages; the loop's i++ will land on the next msg.
    i = j - 1;
    bubbleIdx++;
  }
}

// ── Install all patches after chat.js has run ─────────────────
// setTimeout(0) fires after all synchronous script execution completes,
// so chat.js's globals (updateBubble, addBubble, sendChat) are safe to wrap.
let _fbOrigUpdateBubble = null;

setTimeout(() => {
  if (typeof updateBubble !== 'function' || typeof addBubble !== 'function') {
    console.warn('[fileblocks] chat.js globals not found — rendering disabled.');
    return;
  }

  // Stash the original updateBubble so _fbRenderInto can always call the
  // unwrapped version (avoids double-processing via the patched copy).
  _fbOrigUpdateBubble = updateBubble;

  // eslint-disable-next-line no-global-assign
  updateBubble = _fbPatchedUpdateBubble(updateBubble);
  // eslint-disable-next-line no-global-assign
  addBubble    = _fbPatchedAddBubble(addBubble);

  // restoreChat() runs at chat.js load time — before our patch is installed —
  // so all the history bubbles are already in the DOM by now.
  // We run our reconstruction pass once here, synchronously after patching.
  _fbReconstructToolSummaries();
}, 0);
