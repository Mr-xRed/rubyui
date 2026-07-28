// ══ CHAT.JS ══════════════════════════════════════════════════
// Chat feature: IndexedDB history persistence, file attachments
// conversion, file attachment handling, Markdown + LaTeX renderer,
// message bubble system, response stats bar, streaming send/stop,
// and all chat UI event wiring.
//
// Depends on: config.js  (CHAT_PROMPTS, ACTIVE_PROMPT_ID, getActiveChatSystem,
//                          OLLAMA_BASE, SHOW_STATS)
//             api.js     (API.chatRequest, API.parseChatChunk,
//                         API.resetStream, API.isOllama, etc.)
//             main.js    (ensureModelLoaded, currentAbortController,
//                         modelSel, isMobile)
//
// Load order in index.html:  … → corrector.js → chat.js → …

// ── Chat DOM refs ─────────────────────────────────────────────
const chatMessagesEl = document.getElementById('chat-messages');
const chatEmpty      = document.getElementById('chat-empty');
const chatInput      = document.getElementById('chat-input');
const chatSendBtn    = document.getElementById('chat-send-btn');
const chatStopBtn    = document.getElementById('chat-stop-btn');
const chatClearBtn   = document.getElementById('chat-clear-btn');
const jumpBottomBtn  = document.getElementById('jump-bottom-btn');

// ══ CHAT ═════════════════════════════════════════════════════
let chatHistory = [];
let chatBusy = false;
let lmsResponseId = null; // LM Studio only: chains /api/v1/chat turns via previous_response_id

// ── Backend-mode state ────────────────────────────────────────
// When BACKEND_AVAILABLE is true, sendChat() hands the turn to the server
// and returns immediately.  These variables track the in-flight backend job
// so SSE callbacks (below) can route events to the right bubble.
let _backendJobId      = null; // current/pending server job id
let _backendBubble     = null; // the assistant bubble being streamed into (current turn)
let _backendToolBubble = null; // first-turn bubble — anchors the tool-call summary widget
let _backendReply      = '';   // accumulated reply text (content only, no think)
// Ids of images generated via server-executed generate_image tool calls
// during the CURRENT backend job — used to re-embed <jarvis_img> tags into
// the authoritative chatHistory once the server's finalMessages overwrite it
// (see _chatOnBackendDone's _reinjectBackendToolImages call). Reset in
// lockstep with _backendReply everywhere that resets to ''.
let _backendImgIdsThisTurn = [];
let _backendThink      = '';   // accumulated thinking text
let _backendToolSums   = [];   // accumulated tool summaries [{name,args,result,error}]
// Set of job IDs being handled by _attachJobStream (per-job SSE).
// The global SSE listener skips chunks for these to avoid double-streaming.
const _backendJobStreamActive = new Set();

// ── Tool-generated images (generate_image built-in tool) ──────────
// Deliberately separate from fileblocks.js's <jarvis_file> card system —
// this tag is inserted whole by our own code (tools.js's generate_image
// execute()), never streamed token-by-token by the model, so none of
// fileblocks.js's partial-tag/hold-tail handling is needed here.
//
// _toolImageStore is an in-memory id → {b64,prompt,model,size,genTime} cache.
// It's populated synchronously right when an image finishes generating
// (_registerToolImage, called from tools.js) and re-populated from the
// _toolImages sidecar on each tool-result message when chat history is
// restored after a reload (see restoreChat() and _stripSidecars()).
const _toolImageStore = new Map();
function _registerToolImage(id, data) { _toolImageStore.set(id, data); }

// Persistent (per-CONVERSATION, not per-turn) record of which assistant
// message — identified by its ordinal position among assistant-role
// messages, since finalMessages/chatHistory only ever grows/appends —
// owns which image ids. Needed because _chatOnBackendDone REPLACES
// chatHistory wholesale from the server's finalMessages every single turn
// (finalMessages knows nothing about <jarvis_img> tags), which would
// otherwise wipe out any earlier turn's re-injected tag the moment a NEWER
// turn completes. Reset only on clearChat()/restoreChat() — i.e. when the
// conversation itself changes, not per-turn.
let _toolImagesByAssistantPos = new Map();

(function _injectToolImageStyles() {
  if (document.getElementById('_tool-img-styles')) return;
  const s = document.createElement('style');
  s.id = '_tool-img-styles';
  s.textContent = ``; /* moved to styles.css */
  document.head.appendChild(s);
})();

// ── Live "Step X/Y · ~Ns remaining" on the shimmer placeholder ─────────
// Reuses state backend.js already maintains — no new metrics are computed
// here, this just mirrors the same numbers shown in the ServerJobs modal
// onto the loading label inside the chat bubble:
//   • _jpProgress        — populated from the server's SSE 'progress' events
//   • _toolPendingImageJobIds — the job id(s) generateImageForToolBackend()
//     is currently polling (LOCAL/direct chat path). That function awaits
//     its own /api/jobs poll rather than the shared SSE listener for its
//     completion signal, but the SSE listener still receives 'progress'
//     events for that same job_id in parallel — it's just never correlated
//     to the chat's own job id (there isn't one in this path), so we look
//     it up here instead.
// In the BACKEND-chat path (generateChatBackend()), the whole turn including
// tool execution is one job, so _backendJobId is the id to use directly.
let _chatImgProgressTimer  = null;
let _chatImgProgressBubble = null; // bubble currently showing the shimmer
// Sub-job id(s) announced via the 'chat-tool-image-job' SSE event (see
// server.py's _execute_generate_image_tool + backend.js's SSE listener).
// Needed because a generate_image call executed server-side INSIDE a
// backend chat job spins up its own separate image job — the chat job's own
// job_id (_backendJobId) never receives progress events for it.
let _chatBackendImgSubJobIds = new Set();

function _chatOnBackendToolImageJob(jobId, chatId, subJobId) {
  if (jobId !== _backendJobId || !subJobId) return;
  _chatBackendImgSubJobIds.add(subJobId);
}

function _chatImgProgressJobId() {
  // Most specific first: a sub-job announced for the current backend chat
  // job's in-flight generate_image call carries the real progress data —
  // _backendJobId itself never does. Only fall through to _backendJobId (a
  // harmless no-data lookup) and _toolPendingImageJobIds (the local/direct
  // chat path's own separate job) if no sub-job is currently known.
  for (const id of _chatBackendImgSubJobIds) {
    if (typeof _jpProgress !== 'undefined' && _jpProgress[id]) return id;
  }
  if (_backendJobId) return _backendJobId;
  if (typeof _toolPendingImageJobIds !== 'undefined' && _toolPendingImageJobIds.size) {
    return _toolPendingImageJobIds.values().next().value;
  }
  return null;
}

function _chatImgProgressText() {
  const jobId = (typeof _jpProgress !== 'undefined') ? _chatImgProgressJobId() : null;
  const prog  = jobId ? _jpProgress[jobId] : null;
  if (!prog || prog.step == null || !(prog.steps_total > 0)) return 'Generating…';
  let text = `Generating … Step ${prog.step}/${prog.steps_total}`;
  if (prog._deadline != null) {
    const remaining = Math.max(0, (prog._deadline - Date.now()) / 1000);
    const fmtTime = s => s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
    text += ` · ~${fmtTime(remaining)}`;
  }
  return text;
}

// Updates the label(s) in place (textContent only) — deliberately NOT a
// full updateBubble() re-render, so a once-a-second tick can't interrupt
// markdown streaming or reset scroll position.
function _chatImgProgressTick() {
  if (!_chatImgProgressBubble) return _stopChatImgProgress();
  const labels = _chatImgProgressBubble.querySelectorAll('.tool-img-loading-label');
  if (!labels.length) return _stopChatImgProgress();
  const text = _chatImgProgressText();
  labels.forEach(el => { el.textContent = text; });
}

function _startChatImgProgress(bubble) {
  _chatImgProgressBubble = bubble || _chatImgProgressBubble;
  if (_chatImgProgressTimer) return;
  _chatImgProgressTick();
  _chatImgProgressTimer = setInterval(_chatImgProgressTick, 1000);
}

function _stopChatImgProgress() {
  _chatImgProgressBubble = null;
  if (!_chatImgProgressTimer) return;
  clearInterval(_chatImgProgressTimer);
  _chatImgProgressTimer = null;
}

// Renders a <jarvis_img id="..."> tag as an actual image card. Called from
// renderMarkdownWithLatex() as a post-processing step, same shape as the
// existing KaTeX placeholder substitution just above it.
function _renderToolImageTag(id) {
  const data = _toolImageStore.get(id);
  if (!data) return `<div class="tool-img-missing">[image unavailable]</div>`;
  const src        = data.b64.startsWith('data:') ? data.b64 : `data:image/png;base64,${data.b64}`;
  const safePrompt = (data.prompt || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return (
    `<div class="tool-img-card">` +
      `<img class="tool-img-card-image" src="${src}" alt="${safePrompt}" ` +
        `data-chat-lb-src="${src}" data-chat-lb-label="${safePrompt}" ` +
        `style="cursor:zoom-in" onclick="_openChatLightboxAt(this)">` +
      `<div class="tool-img-card-actions">` +
        `<button type="button" class="tool-img-card-btn" onclick="_toolImgSaveToGallery('${id}')">Save to gallery</button>` +
        `<button type="button" class="tool-img-card-btn" onclick="_toolImgDownload('${id}')">Download</button>` +
      `</div>` +
    `</div>`
  );
}

// "Save to gallery" — opt-in only; generate_image never touches the
// gallery/IndexedDB automatically (see generateImageForTool() in image.js).
function _toolImgSaveToGallery(id) {
  const data = _toolImageStore.get(id);
  if (!data) return;
  if (typeof imgDbAdd !== 'function' || typeof addImageToGallery !== 'function') {
    if (typeof showToast === 'function') showToast('Gallery is unavailable (image.js not loaded).', 3000);
    return;
  }
  const entry = {
    id: 'gal_' + id, b64: data.b64, prompt: data.prompt,
    model: data.model, size: data.size, genTime: data.genTime || '', ts: Date.now()
  };
  imgDbAdd(entry).catch(() => {});
  addImageToGallery(entry, typeof imgSortDesc !== 'undefined' ? imgSortDesc : true);
  if (typeof showToast === 'function') showToast('Saved to gallery.', 2500);
}

function _toolImgDownload(id) {
  const data = _toolImageStore.get(id);
  if (!data) return;
  const src = data.b64.startsWith('data:') ? data.b64 : `data:image/png;base64,${data.b64}`;
  const a = document.createElement('a');
  a.href = src;
  a.download = `${(data.prompt || 'image').slice(0, 40).replace(/[^\w\-]+/g, '_') || 'image'}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Backend-chat path only: finalMessages (server's authoritative message log)
// has no idea <jarvis_img> tags exist — those are only added to the live
// bubble client-side. Called every time finalMessages overwrites chatHistory
// (i.e. every turn), this re-embeds EVERY known turn's tags — not just the
// current one — into their respective assistant messages by position, using
// _toolImagesByAssistantPos, so earlier turns' images survive being wiped
// out by this turn's wholesale chatHistory replacement.
function _reinjectBackendToolImages(msgs) {
  if (!_toolImagesByAssistantPos.size || !msgs || !msgs.length) return;
  let assistantIdx = -1;
  for (const msg of msgs) {
    if (msg.role !== 'assistant') continue;
    assistantIdx++;
    const imgIds = _toolImagesByAssistantPos.get(assistantIdx);
    if (!imgIds || !imgIds.length) continue;

    let content = msg.content || '';
    // finalMessages is the SERVER's own log of what it sent to the model —
    // which means earlier turns may already have had their <jarvis_img> tag
    // swapped for the literal "[Image shown to user]" placeholder server-side
    // (the same trick _stripSidecars() does client-side, so the model isn't
    // re-fed image data every turn). That placeholder is for the model's
    // eyes only; strip any stray copies before we decide what's "missing"
    // and before this becomes the persisted/rendered chatHistory, otherwise
    // it accumulates by one extra line every time finalMessages overwrites
    // chatHistory (once per turn that touches this message's context).
    if (content.includes('[Image shown to user]')) {
      content = content.split('[Image shown to user]').join('').trim();
    }

    const missing = imgIds.filter(id => !content.includes(`id="${id}"`));
    if (missing.length) {
      const prefix = missing.map(id => `<jarvis_img id="${id}"></jarvis_img>`).join('\n') + '\n\n';
      content = prefix + content;
    }
    msg.content = content;
    const sidecar = msg._toolImages || {};
    for (const id of imgIds) if (_toolImageStore.has(id)) sidecar[id] = _toolImageStore.get(id);
    if (Object.keys(sidecar).length) msg._toolImages = sidecar;
  }
}

// ── IndexedDB chat persistence ────────────────────────────────
const _DB_NAME  = 'jarvis_db';
const _DB_VER   = 1;
const _DB_STORE = 'chat_store';
const _CHAT_KEY = 'last_chat';

function _openChatDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_DB_NAME, _DB_VER);
    req.onupgradeneeded = e => e.target.result.createObjectStore(_DB_STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

// Sanitise history before writing to IndexedDB.
// Rules:
//   • OpenAI multipart image_url parts → replaced with {_omitted:true} stubs.
//   • Plain image uploads (Ollama msg.images, no _pdfPages sidecar) → moved to
//     a _attachImages sidecar so they can be fully restored after a reload.
//   • PDF page renders → kept via the _pdfPages sidecar on the message.
//     msg.images is rebuilt from _pdfPages on restore so the model regains
//     full vision context after a page reload.
function _sanitizeHistory(messages) {
  return messages.map(msg => {
    // Strip OpenAI-format image_url parts from multipart content
    const content = Array.isArray(msg.content)
      ? msg.content.map(part =>
          part.type === 'image_url' ? { type: 'image_url', _omitted: true } : part
        )
      : msg.content;

    const out = { ...msg, content };

    // Always strip msg.images before storing — it is a runtime-only field rebuilt
    // on restore.  For PDF messages _pdfPages is the source of truth.  For plain
    // image uploads we persist the b64 data in a dedicated _attachImages sidecar
    // so thumbnails and model vision context can be fully restored after a reload.
    if (Array.isArray(out.images) && out.images.length) {
      if (Array.isArray(out._pdfPages)) {
        // PDF message — _pdfPages already carries the data; drop runtime images.
        delete out.images;
      } else {
        // Plain image upload — save b64 in sidecar; _attachImagesMeta is already
        // on the message (set by applyAttachment at send time).
        out._attachImages = out.images.slice();
        delete out.images;
      }
    }
    return out;
  });
}

// Strip persistence-only sidecar fields from messages before sending to the
// model API.  These fields (_pdfPages, _pdfMeta, _attachImages, _attachImagesMeta,
// _visualScores) exist solely for IndexedDB persistence, page-reload thumbnail
// reconstruction, and export/import.  The model API never interprets them, but
// they can add megabytes of base64 PNG data to every request if left in place.
//
// Unlike _sanitizeHistory (which is destructive — it also removes msg.images),
// this function is non-destructive on chatHistory: it returns new shallow-cloned
// message objects with only the sidecar keys omitted.  msg.images, msg.content,
// and all other fields the model actually uses are passed through unchanged.
const _SIDECAR_KEYS = ['_pdfPages', '_pdfMeta', '_attachImages', '_attachImagesMeta', '_visualScores', '_toolImages'];

// Matches our own <jarvis_img id="..."> tags embedded in message content by
// _reinjectBackendToolImages()/the local tool-call loop. These must never
// reach the model: besides wasting tokens, once a model has seen this exact
// tag syntax in its OWN prior turn (chatHistory becomes conversation history
// on every subsequent request), it can start mimicking/hallucinating the
// pattern in its own free-text replies — producing a second, bogus tag with
// an id that resolves to nothing (renders as "[image unavailable]").
const _JARVIS_IMG_TAG_RE = /<jarvis_img\s+id="[^"]*"\s*\/?>(?:\s*<\/jarvis_img>)?/g;

function _stripSidecars(messages) {
  return messages.map(msg => {
    const hasSidecar = _SIDECAR_KEYS.some(k => k in msg);
    const hasImgTag   = typeof msg.content === 'string' && msg.content.includes('<jarvis_img');
    if (!hasSidecar && !hasImgTag) return msg; // fast path — nothing to strip
    const out = { ...msg };
    for (const k of _SIDECAR_KEYS) delete out[k];
    if (hasImgTag) out.content = out.content.replace(_JARVIS_IMG_TAG_RE, '[Image shown to user]').trim();
    return out;
  });
}

// Last known prompt_eval_count (inputTokens) — updated by updateCtxMonitor()
// so saveChatHistory() can persist it without coupling to the stats flow.
let _lastCtxUsed = null;

async function saveChatHistory() {
  if (!chatHistory.length) return;
  try {
    const db = await _openChatDB();
    const tx = db.transaction(_DB_STORE, 'readwrite');
    const record = {
      messages: _sanitizeHistory(chatHistory),
      savedAt:  Date.now(),
    };
    if (_lastCtxUsed !== null) record.ctxUsed = _lastCtxUsed;
    tx.objectStore(_DB_STORE).put(record, _CHAT_KEY);
  } catch (e) { console.warn('Chat save failed:', e); }
}

async function _clearChatDB() {
  try {
    const db = await _openChatDB();
    const tx = db.transaction(_DB_STORE, 'readwrite');
    tx.objectStore(_DB_STORE).delete(_CHAT_KEY);
  } catch (e) { console.warn('Chat DB clear failed:', e); }
}

// Build the attachmentInfo list and restore model-context images for a
// persisted user message.  Handles three cases:
//   1. PDF pages  — restores msg.images from _pdfPages sidecar so the model
//                   regains vision context; also builds thumbnail chips.
//   2. Plain images — restores msg.images from _attachImages sidecar so the
//                     model regains vision context and thumbnails are shown.
//   3. Omitted OpenAI multipart images — builds placeholder chips.
// Mutates msg in-place (restores msg.images) and returns the attachmentInfo array.
function _restoreMsgAttachments(msg) {
  if (msg.role !== 'user') return null;

  // ── Case 1: PDF pages stored in _pdfPages sidecar ────────────────
  if (Array.isArray(msg._pdfPages) && msg._pdfPages.length) {
    // Rebuild msg.images directly from the sidecar — do NOT spread into any
    // existing msg.images, since _sanitizeHistory always strips that field
    // before saving.  Appending would double/triple the array on each reload.
    msg.images = msg._pdfPages.slice();

    // Build one info entry per PDF file using the stored metadata,
    // then synthesise thumbnail chips identical to those built in sendChat().
    const metaList = Array.isArray(msg._pdfMeta) ? msg._pdfMeta : [];
    // If meta is missing (older saves), fall back to a single generic entry.
    if (!metaList.length) {
      return [{
        type:       'pdf',
        name:       'document.pdf',
        pageImages: msg._pdfPages,
        pageCount:  msg._pdfPages.length,
        hasText:    false,  // unknown — show thumbnails to be safe
      }];
    }
    // Distribute pages across files proportionally using stored pageCount.
    // hasText is stored in _pdfMeta so the restore path can suppress thumbnails
    // for text-PDFs exactly as the live send path does.
    let offset = 0;
    return metaList.map(m => {
      const count = m.pageCount || msg._pdfPages.length;
      const pages = msg._pdfPages.slice(offset, offset + count);
      offset += count;
      return {
        type:       'pdf',
        name:       m.name,
        pageImages: pages,
        pageCount:  count,
        hasText:    Boolean(m.hasText),
      };
    });
  }

  // ── Case 2: plain image uploads stored in _attachImages sidecar ──────
  if (Array.isArray(msg._attachImages) && msg._attachImages.length) {
    // Restore runtime msg.images so the model gets vision context on the
    // next turn (same behaviour as the original send path).
    msg.images = msg._attachImages.slice();
    const metaList = Array.isArray(msg._attachImagesMeta) ? msg._attachImagesMeta : [];
    return msg._attachImages.map((b64, i) => {
      let mime = 'image/jpeg';
      if (b64.startsWith('iVBOR'))     mime = 'image/png';
      else if (b64.startsWith('R0lG')) mime = 'image/gif';
      else if (b64.startsWith('UklG')) mime = 'image/webp';
      const meta = metaList[i] || {};
      return {
        type:      'image',
        name:      meta.name || `image ${i + 1}`,
        size:      meta.size ?? null,
        objectUrl: `data:${mime};base64,${b64}`,
      };
    });
  }

  // ── Case 3: omitted OpenAI multipart images ───────────────────────
  if (Array.isArray(msg.content)) {
    const omittedCount = msg.content.filter(p => p._omitted).length;
    if (omittedCount === 1)
      return [{ type: 'file', name: '(image — not restored)' }];
    if (omittedCount > 1)
      return Array.from({ length: omittedCount },
        (_, i) => ({ type: 'file', name: `(image ${i + 1} — not restored)` }));
  }

  return null;
}

async function restoreChat() {
  try {
    const db   = await _openChatDB();
    const data = await new Promise((resolve, reject) => {
      const tx  = db.transaction(_DB_STORE, 'readonly');
      const req = tx.objectStore(_DB_STORE).get(_CHAT_KEY);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
    if (!data?.messages?.length) return;

    chatHistory = data.messages;
    _toolImagesByAssistantPos = new Map();   // rebuilt below — this is a different conversation
    let _restoreAssistantIdx = -1;
    for (const msg of chatHistory) {
      if (msg.role === 'assistant') _restoreAssistantIdx++;
      // Repopulate _toolImageStore BEFORE this message's bubble renders, so
      // any <jarvis_img id="..."> tag in its content resolves immediately.
      if (msg._toolImages) {
        const ids = Object.keys(msg._toolImages);
        for (const [id, imgData] of Object.entries(msg._toolImages)) _toolImageStore.set(id, imgData);
        if (ids.length) _toolImagesByAssistantPos.set(_restoreAssistantIdx, ids);
      }
      // _restoreMsgAttachments mutates msg (restores msg.images from _pdfPages)
      // and returns the attachmentInfo array for addBubble.
      const attachmentInfo = _restoreMsgAttachments(msg);
      const text = Array.isArray(msg.content)
        ? (msg.content.find(p => p.type === 'text')?.text || '')
        : (msg.content || '');
      addBubble(msg.role, text, false, null, attachmentInfo);
    }
    chatEmpty.style.display = 'none';
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

    // Restore the context usage bar from the persisted token count.
    // Find the last assistant bubble that was just rendered and attach the bar to it.
    if (data.ctxUsed != null) {
      _lastCtxUsed = data.ctxUsed;
      const allBubbles = chatMessagesEl.querySelectorAll('.msg.assistant .msg-bubble');
      const lastBubble = allBubbles[allBubbles.length - 1] ?? null;
      if (lastBubble) updateCtxMonitor({ inputTokens: data.ctxUsed }, lastBubble);
    }
  } catch (e) { console.warn('Chat restore failed:', e); }
}
restoreChat();

// ── Stable chat session ID ────────────────────────────────────
// Used to correlate backend jobs with this chat session.
// Survives page reloads and tab closes via localStorage (one ID per browser).
const CHAT_ID = (() => {
  const KEY = 'jarvis_chat_id';
  let id = localStorage.getItem(KEY);
  if (!id) { id = Math.random().toString(36).slice(2, 12); localStorage.setItem(KEY, id); }
  return id;
})();

// ── Backend SSE callbacks (called by backend.js) ──────────────
// These must be present in global scope before backend.js's SSE
// listener fires, which is guaranteed because chat.js loads first.

// A chunk of streamed text arrived from the server.
// The server sends thinking and content as separate fields — no need to
// parse <think> tags here; that's only for the local direct-Ollama path.
function _chatOnBackendChunk(jobId, chatId, chunk, thinkingChunk) {
  if (jobId !== _backendJobId) return;
  if (thinkingChunk) {
    _backendThink += thinkingChunk;
    if (_backendBubble) updateThinkBubble(_backendBubble, _backendThink, true);
  }
  if (chunk) {
    _backendReply += chunk;
    if (_backendBubble) updateBubble(_backendBubble, _backendReply, true);
  }
}

// Tool calls executed server-side — update the summary UI.
// Fired when the server is ABOUT to execute this round's tool calls (before
// chat-tool-calls, which only arrives once they've finished) — purely so we
// can show the same loading shimmer the local/direct tool-call loop shows.
// Transient only: whatever this writes gets overwritten by the real content
// once _chatOnBackendToolCalls (or the next chat-chunk) runs.
function _chatOnBackendToolStart(jobId, chatId, calls) {
  if (jobId !== _backendJobId || !_backendBubble) return;
  const loadingTags = (calls || [])
    .filter(c => c.name === 'generate_image')
    .map(() => `<jarvis_img_loading></jarvis_img_loading>`)
    .join('\n');
  if (!loadingTags) return;
  updateBubble(_backendBubble,
    (_backendReply || '') + (_backendReply ? '\n\n' : '') + loadingTags,
    true
  );
  _startChatImgProgress(_backendBubble);
}

function _chatOnBackendToolCalls(jobId, chatId, toolSummaries, images) {
  if (jobId !== _backendJobId) return;
  _stopChatImgProgress();
  _chatBackendImgSubJobIds.clear();

  // ── generate_image results (server-executed tool calls) ────────
  // `images` is scoped to THIS round only (see the notify() call in
  // server.py) — b64 travels directly in the SSE event, so no follow-up
  // fetch/poll is needed here, unlike an earlier version of this function.
  // toolSummaries, by contrast, is the FULL cumulative list across all
  // rounds so far (needed for _appendToolSummary's from-scratch redraw) —
  // deliberately NOT used to detect images, since re-scanning it every
  // round would re-process earlier rounds' already-registered images.
  const roundImageIds = [];
  for (const img of (images || [])) {
    _registerToolImage(img.id, {
      b64: img.b64, prompt: img.prompt, model: img.model, size: img.size, genTime: img.gen_time || ''
    });
    roundImageIds.push(img.id);
    _backendImgIdsThisTurn.push(img.id);
  }

  // Cosmetic only: strip the marker from what's shown in the tool-call
  // summary widget. Safe to run on the full list every time — stripping
  // already-stripped text is a no-op.
  _backendToolSums = toolSummaries.map(s => {
    const stripped = (s.result || '').replace(/\[\[JARVIS_IMAGE:[A-Za-z0-9_]+\]\]\s*/, '').trim();
    return { ...s, result: stripped || s.result || 'Image generated and shown to the user.' };
  });

  if (_backendBubble) {
    const callsAndResults = _backendToolSums.map(s => ({
      tc:     { function: { name: s.name, arguments: s.args || {} } },
      result: s.result || '',
      error:  s.error  || false,
    }));

    // First tool round: freeze the current bubble as the summary anchor.
    // Hide it if the model emitted no pre-tool text.
    if (!_backendToolBubble) {
      _backendToolBubble = _backendBubble;
      updateBubble(_backendToolBubble, _backendReply, false);
      if (!_backendReply) {
        _backendToolBubble.style.display = 'none';
        const copyBtn = _backendToolBubble.parentElement?.querySelector('.bubble-copy-btn');
        if (copyBtn) copyBtn.style.display = 'none';
      }
    }
    _appendToolSummary(_backendToolBubble, callsAndResults);

    // Any images generated this round render immediately via their
    // <jarvis_img> tags — before the model's own follow-up text streams in
    // below them.
    const newImageTags = roundImageIds.map(id => `<jarvis_img id="${id}"></jarvis_img>`).join('\n')
                        + (roundImageIds.length ? '\n\n' : '');
    if (_backendBubble === _backendToolBubble) {
      // First round: bubble A (the anchor) was just frozen above with
      // whatever pre-tool text it had. Start a brand-new bubble fresh.
      _backendReply = newImageTags;
      _backendBubble = addBubble('assistant', _backendReply, true);
    } else {
      // Later round reusing the same bubble (avoids leaving orphan empty
      // bubbles in the DOM) — APPEND this round's tags rather than
      // overwriting, so an earlier round's image already in this bubble
      // isn't wiped out by this round's.
      _backendReply = (_backendReply || '') + newImageTags;
      updateBubble(_backendBubble, _backendReply, true);
    }
  }
}

// Generation complete — finalize bubble and update history.
function _chatOnBackendDone(jobId, chatId, reply, finalMessages, genTime, rawStats) {
  // Cold reconnect: job finished while the tab was closed.
  // _backendJobId is null and there is no bubble yet — create one now.
  if (jobId !== _backendJobId) {
    if (_backendJobId !== null) return; // different active job — ignore
    // Only inject if the reply belongs to the current chat session
    if (chatId && typeof CHAT_ID !== 'undefined' && chatId !== CHAT_ID) return;
    // Build a bubble from scratch and persist to history
    const coldBubble = addBubble('assistant', reply || '', false);
    if (genTime && coldBubble) {
      const wrap = coldBubble.closest?.('.msg-wrap') || coldBubble.parentElement;
      wrap?.querySelector('.msg-stats-bar')?.remove();
      const bar = document.createElement('div');
      bar.className = 'msg-stats-bar';
      bar.textContent = `\u23f1 total ${genTime} \u00b7 backend`;
      wrap?.appendChild(bar);
    }
    if (finalMessages && finalMessages.length > 0) {
      const firstNonSystem = finalMessages.findIndex(m => m.role !== 'system');
      chatHistory = firstNonSystem > 0
        ? finalMessages.slice(firstNonSystem)
        : finalMessages.slice();
    } else if (reply) {
      chatHistory.push({ role: 'assistant', content: reply });
    }
    saveChatHistory();
    return;
  }

  // Replace local history with the server's authoritative messages, and
  // re-embed every known turn's <jarvis_img> tags — BEFORE finalizing the
  // live bubble below, so the live DOM and the persisted chatHistory always
  // show the exact same content. (Previously the live bubble was finalized
  // using the raw `reply` parameter below, which is the server's plain text
  // and never contains our tags — wiping the image from the DOM the instant
  // streaming finished, even though chatHistory/reload were already correct
  // via the SAME reinject call, just too late to help the live bubble.)
  // Strip any leading system messages before storing — sendChat() prepends
  // the active system prompt fresh every turn, so chatHistory must never
  // contain system messages at the start, otherwise they accumulate.
  if (finalMessages && finalMessages.length > 0) {
    const firstNonSystem = finalMessages.findIndex(m => m.role !== 'system');
    chatHistory = firstNonSystem > 0
      ? finalMessages.slice(firstNonSystem)
      : finalMessages.slice();
  } else {
    chatHistory.push({ role: 'assistant', content: reply || _backendReply });
  }
  // Record which assistant message (by position) this turn's images belong
  // to, THEN re-embed every known turn's tags — not just this one — since
  // finalMessages just wiped out any earlier turn's re-injected tag above.
  if (_backendImgIdsThisTurn.length) {
    const assistantPos = chatHistory.reduce((n, m) => n + (m.role === 'assistant' ? 1 : 0), 0) - 1;
    if (assistantPos >= 0) _toolImagesByAssistantPos.set(assistantPos, _backendImgIdsThisTurn.slice());
  }
  _reinjectBackendToolImages(chatHistory);

  // Finalise the streamed bubble — use the just-reinjected chatHistory
  // content (single source of truth, tags included) rather than the raw
  // `reply` parameter, which never carries our tags.
  if (_backendBubble) {
    const lastAssistant = [...chatHistory].reverse().find(m => m.role === 'assistant');
    const finalContent  = lastAssistant?.content || reply || _backendReply;
    updateBubble(_backendBubble, finalContent, false);
    // Close the thinking block (stops spinner, collapses it)
    if (_backendThink) updateThinkBubble(_backendBubble, _backendThink, false);
    // Render the proper stats bar using the same pipeline as local mode
    if (rawStats) {
      renderStatsBar(_backendBubble, parseStats(rawStats, null));
    } else if (genTime) {
      const wrap = _backendBubble.closest?.('.msg-wrap') || _backendBubble.parentElement;
      wrap?.querySelector('.msg-stats-bar')?.remove();
      const bar = document.createElement('div');
      bar.className = 'msg-stats-bar';
      bar.textContent = `⏱ total ${genTime} · backend`;
      wrap?.appendChild(bar);
    }
  }

  API.resetStream(); // reset _inThink state for next turn
  _stopChatImgProgress();
  _backendJobId      = null;
  _backendBubble     = null;
  _backendToolBubble = null;
  _backendReply      = '';
  _backendImgIdsThisTurn = [];
  _chatBackendImgSubJobIds.clear();
  _backendThink      = '';
  _backendToolSums   = [];

  chatBusy = false;
  chatSendBtn.classList.remove('hidden');
  chatStopBtn.classList.add('hidden');
  chatInput.focus();
  saveChatHistory();
}

// Error or cancellation from the server.
function _chatOnBackendError(jobId, chatId, errorMsg) {
  if (jobId !== _backendJobId) return;

  if (_backendBubble) {
    const text = errorMsg.startsWith('[') ? errorMsg : `Error: ${errorMsg}`;
    updateBubble(_backendBubble, text, false);
    if (_backendThink) updateThinkBubble(_backendBubble, _backendThink, false);
    if (!errorMsg.startsWith('[Generation cancelled')) {
      _backendBubble.style.color = 'var(--red)';
    }
    chatHistory.push({ role: 'assistant', content: text });
  }

  API.resetStream();
  _stopChatImgProgress();
  _backendJobId      = null;
  _backendBubble     = null;
  _backendToolBubble = null;
  _backendReply      = '';
  _backendImgIdsThisTurn = [];
  _chatBackendImgSubJobIds.clear();
  _backendThink      = '';
  _backendToolSums   = [];

  chatBusy = false;
  chatSendBtn.classList.remove('hidden');
  chatStopBtn.classList.add('hidden');
  chatInput.focus();
  saveChatHistory();
}

// Reconnect: called by backend.js when a chat job for this client was found
// still running after page reload.  We create a waiting bubble and hand back
// the job_id so backend.js can attach the per-job stream.
function _chatOnBackendReconnect(jobId, jobChatId) {
  // Don't create a duplicate bubble if we already know about this job
  if (_backendJobId === jobId) return;

  _backendJobId  = jobId;
  _backendReply  = '';
  _backendImgIdsThisTurn = [];
  _chatBackendImgSubJobIds.clear();
  _backendThink  = '';
  // Empty string + streaming=true shows the blinking cursor while we wait
  // for the first replay chunk; updateBubble will replace it immediately.
  _backendBubble = addBubble('assistant', '', true);
  chatBusy       = true;
  chatSendBtn.classList.add('hidden');
  chatStopBtn.classList.remove('hidden');

  // Mark this job as handled by per-job stream so global SSE skips its chunks
  _backendJobStreamActive.add(jobId);

  // Delegate to backend.js to open the per-job replay stream
  if (typeof _attachJobStream === 'function') {
    _attachJobStream(jobId, jobChatId);
  }
}

let shouldAutoScroll = true;
let chatTouchStartY  = 0;
// Brief flag set whenever the user initiates an upward scroll gesture.
// Prevents the 'scroll' event (which fires in the same tick) from immediately
// overriding shouldAutoScroll=false and snapping focus back to the bottom.
let _userScrolling   = false;
let _userScrollTimer = null;

function _markUserScrolling() {
  _userScrolling = true;
  clearTimeout(_userScrollTimer);
  _userScrollTimer = setTimeout(() => { _userScrolling = false; }, 200);
}

// ── Scroll-lock: detect upward scroll intent immediately ──────
chatMessagesEl.addEventListener('wheel', (e) => {
  if (chatMessagesEl.scrollHeight <= chatMessagesEl.clientHeight) return;
  if (e.deltaY < 0) {
    _markUserScrolling();
    shouldAutoScroll = false;
    jumpBottomBtn.classList.remove('hidden');
  }
}, { passive: true });

chatMessagesEl.addEventListener('touchstart', (e) => {
  chatTouchStartY = e.touches[0].clientY;
}, { passive: true });

chatMessagesEl.addEventListener('touchmove', (e) => {
  if (chatMessagesEl.scrollHeight <= chatMessagesEl.clientHeight) return;
  const dy = e.touches[0].clientY - chatTouchStartY;
  if (dy > 5) {
    _markUserScrolling();
    shouldAutoScroll = false;
    jumpBottomBtn.classList.remove('hidden');
  }
}, { passive: true });

chatMessagesEl.addEventListener('scroll', () => {
  // Don't re-enable auto-scroll during an active user scroll gesture —
  // the position may not have updated yet and isAtBottom would be stale.
  if (_userScrolling) return;
  const threshold = 60;
  const isAtBottom = chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop <= chatMessagesEl.clientHeight + threshold;
  if (isAtBottom) { shouldAutoScroll = true; jumpBottomBtn.classList.add('hidden'); }
});

jumpBottomBtn.addEventListener('click', () => {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  shouldAutoScroll = true;
  jumpBottomBtn.classList.add('hidden');
});


// ── File attachment state + handling ─────────────────────────
// Each entry: { file, type: 'image'|'pdf'|'text', b64: string|null, text: string|null }
let chatAttachments = [];
// Tracks how many async attachment-processing operations (PDF rendering,
// MarkItDown conversion) are still in-flight.  sendChat() waits until this
// reaches 0 so it never snapshots a half-processed attachment object.
let _attachProcessing = 0;

const chatFileInput     = document.getElementById('chat-file-input');
const chatAttachBtn     = document.getElementById('chat-attach-btn');
const chatAttachPreview = document.getElementById('chat-attach-preview');

// Keep legacy single-attachment aliases so external callers (e.g. sendChat
// backend path) still work without changes.
Object.defineProperties(window, {
  chatAttachedFile: { get: () => chatAttachments[0]?.file  ?? null, configurable: true },
  chatAttachedB64:  { get: () => chatAttachments[0]?.b64   ?? null, configurable: true },
  chatAttachedType: { get: () => chatAttachments[0]?.type  ?? null, configurable: true },
  chatAttachedText: { get: () => chatAttachments[0]?.text  ?? null, configurable: true },
});

// ── Inject chip styles (once) ─────────────────────────────────
(function _injectAttachChipStyles() {
  if (document.getElementById('_jarvis-chip-styles')) return;
  const s = document.createElement('style');
  s.id = '_jarvis-chip-styles';
  s.textContent = ``; /* moved to styles.css */
  document.head.appendChild(s);
})();

// ── Chip builder helpers ──────────────────────────────────────
function _fmtBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024*1024)  return `${(bytes/1024).toFixed(0)} KB`;
  return `${(bytes/1024/1024).toFixed(1)} MB`;
}

// Build the status (row-2) content for one attachment.
// Returns { text, meta, state } where state is 'processing'|'ready'|'error'.
function _chipStatus(att) {
  // ── Still processing ──────────────────────────────────────────
  if (att._processing) {
    const progress  = att._progress  || null; // { done, total } or null
    const statusMsg = att._statusMsg || 'Processing…';
    return { statusMsg, progress, state: 'processing' };
  }

  // ── Error ─────────────────────────────────────────────────────
  if (att._error) {
    return { statusMsg: att._error, progress: null, state: 'error' };
  }

  // ── Ready: build an informative summary line ──────────────────
  const parts = [];

  if (att.type === 'image') {
    const size = _fmtBytes(att.file?.size);
    if (size) parts.push(size);
    parts.push('image');
  } else if (att.type === 'pdf') {
    const size = _fmtBytes(att.file?.size);
    if (size) parts.push(size);
    const pg = att.pageCount;
    if (pg) parts.push(`${pg} page${pg !== 1 ? 's' : ''}`);
    if (Array.isArray(att.visualPages) && Array.isArray(att.pageImages)) {
      const total   = att.pageImages.length;
      const visual  = att.visualPages.length;
      const textPgs = total - visual;
      if (visual === 0)      parts.push('text only');
      else if (textPgs === 0) parts.push('vision');
      else                   parts.push(`${visual} img · ${textPgs} txt`);
    }
  } else {
    // text / office
    const size = _fmtBytes(att.file?.size);
    if (size) parts.push(size);
    if (att.text) {
      const words = att.text.trim().split(/\s+/).length;
      parts.push(`~${words.toLocaleString()} words`);
    }
  }

  return { statusMsg: parts.join('  ·  '), progress: null, state: 'ready' };
}

// Build a full chip DOM node for attachment at index i.
function _buildChipNode(att, i) {
  const chip = document.createElement('div');
  chip.className = 'chat-attach-chip-item';
  chip.dataset.chipIdx = i;

  // ── Row 1: icon/thumb + filename + remove ────────────────────
  const row1 = document.createElement('div');
  row1.className = 'chip-row1';

  if (att.type === 'image' && att.file) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(att.file);
    img.className = 'chat-attach-img-thumb';
    img.alt = att.file.name;
    row1.appendChild(img);
  } else {
    const icon = document.createElement('span');
    icon.className = 'chat-attach-icon';
    if (att.type === 'pdf') {
      icon.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e84040" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>`;
    } else {
      icon.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
    }
    row1.appendChild(icon);
  }

  const nameSpan = document.createElement('span');
  nameSpan.className = 'chat-attach-name';
  nameSpan.textContent = att.file?.name || att._label || '';
  row1.appendChild(nameSpan);

  // ── PDF vision toggle (row 1, only when ready) ───────────────
  if (att.type === 'pdf' && !att._processing && Array.isArray(att.visualPages)) {
    const scorerWantsVision = att.visualPages.length > 0;
    const effectiveVision   = att.visualOverride !== null && att.visualOverride !== undefined
      ? att.visualOverride
      : scorerWantsVision;

    const toggle = document.createElement('button');
    toggle.className = 'pdf-vision-toggle' +
      (effectiveVision ? ' pvt-on' : '') +
      (att.visualOverride !== null && att.visualOverride !== undefined ? ' pvt-override' : '');
    toggle.title = effectiveVision
      ? 'Sent as image to vision model — click to force text-only'
      : 'Sent as text only — click to force image mode';

    const eyeSvg = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const txtSvg = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>`;
    toggle.innerHTML = (effectiveVision ? eyeSvg : txtSvg) + (effectiveVision ? 'img' : 'txt');

    toggle.addEventListener('click', e => {
      e.stopPropagation();
      if (att.visualOverride === null || att.visualOverride === undefined) {
        att.visualOverride = !scorerWantsVision;
      } else if (att.visualOverride === !scorerWantsVision) {
        att.visualOverride = scorerWantsVision;
      } else {
        att.visualOverride = null;
      }
      _renderAttachChips();
    });
    row1.appendChild(toggle);
  }

  // ── Excel sheet-picker toggle (row 1, only when ready & multi-sheet) ──
  if (att.type === 'text' && !att._processing && Array.isArray(att._xlsxAllSheets) && att._xlsxAllSheets.length > 1) {
    const total = att._xlsxAllSheets.length;
    const sel   = (att._xlsxSelectedSheets || att._xlsxAllSheets.map(s => s.name)).length;

    const toggle = document.createElement('button');
    toggle.className = 'xlsx-sheets-toggle' + (sel < total ? ' xst-filtered' : '');
    toggle.title = 'Choose which sheets to include';
    toggle.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="21"/></svg>${sel}/${total} sheets`;

    toggle.addEventListener('click', e => {
      e.stopPropagation();
      _reopenSheetPicker(i);
    });
    row1.appendChild(toggle);
  }

  const removeBtn = document.createElement('button');
  removeBtn.className = 'chat-attach-remove';
  removeBtn.title = 'Remove';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    chatAttachments.splice(i, 1);
    if (!chatAttachments.length) {
      chatAttachPreview?.classList.add('hidden');
      chatAttachBtn?.classList.remove('has-file');
    } else {
      _renderAttachChips();
    }
  });
  row1.appendChild(removeBtn);
  chip.appendChild(row1);

  // ── Row 2: status / progress / meta ─────────────────────────
  const row2 = document.createElement('div');
  row2.className = 'chip-row2';
  row2.dataset.statusRow = '1';
  chip.appendChild(row2);
  _updateChipStatusRow(row2, att);

  // Apply border state class
  _applyChipStateClass(chip, att);

  return chip;
}

// Update only the status row of an existing chip in-place (no full rebuild).
function _updateChipStatusRow(row2, att) {
  row2.innerHTML = '';
  const { statusMsg, progress, state } = _chipStatus(att);

  row2.className = 'chip-row2 chip-' + state;

  if (state === 'processing') {
    const spinner = document.createElement('span');
    spinner.className = 'chip-spinner';
    row2.appendChild(spinner);

    const msg = document.createElement('span');
    msg.className = 'chip-meta';
    msg.textContent = statusMsg;
    row2.appendChild(msg);

    if (progress && progress.total > 0) {
      const wrap = document.createElement('div');
      wrap.className = 'chip-progress-wrap';
      const bar = document.createElement('div');
      bar.className = 'chip-progress-bar';
      bar.style.width = `${Math.round((progress.done / progress.total) * 100)}%`;
      wrap.appendChild(bar);
      row2.appendChild(wrap);

      const pct = document.createElement('span');
      pct.className = 'chip-meta';
      pct.textContent = `${progress.done}/${progress.total}`;
      row2.appendChild(pct);
    }
  } else if (state === 'ready') {
    const icon = document.createElement('span');
    icon.className = 'chip-ready-icon';
    // Checkmark SVG
    icon.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    row2.appendChild(icon);

    if (statusMsg) {
      const msg = document.createElement('span');
      msg.className = 'chip-meta';
      msg.textContent = statusMsg;
      row2.appendChild(msg);
    }
  } else if (state === 'error') {
    const msg = document.createElement('span');
    msg.className = 'chip-meta';
    msg.textContent = statusMsg;
    row2.appendChild(msg);
  }
}

function _applyChipStateClass(chip, att) {
  chip.classList.remove('chip-state-processing', 'chip-state-ready', 'chip-state-error');
  if (att._processing)   chip.classList.add('chip-state-processing');
  else if (att._error)   chip.classList.add('chip-state-error');
  else                   chip.classList.add('chip-state-ready');
}

// Full re-render of all chips (used on initial attach / removal / toggle).
function _renderAttachChips() {
  const container = document.getElementById('chat-attach-chips');
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < chatAttachments.length; i++) {
    container.appendChild(_buildChipNode(chatAttachments[i], i));
  }
}

// Lightweight in-place refresh of one chip's status row — called during
// processing to show live progress without re-rendering the whole list.
function _refreshChip(i) {
  const container = document.getElementById('chat-attach-chips');
  if (!container) return;
  const att  = chatAttachments[i];
  if (!att)  return;
  const chip = container.querySelector(`[data-chip-idx="${i}"]`);
  if (!chip) { _renderAttachChips(); return; } // safety fallback
  const row2 = chip.querySelector('[data-status-row]');
  if (row2) _updateChipStatusRow(row2, att);
  _applyChipStateClass(chip, att);
}

function clearChatAttachment() {
  chatAttachments = [];
  _attachProcessing = 0;
  if (chatAttachPreview) chatAttachPreview.classList.add('hidden');
  if (chatAttachBtn)     chatAttachBtn.classList.remove('has-file');
  if (chatFileInput)     chatFileInput.value = '';
  const container = document.getElementById('chat-attach-chips');
  if (container) container.innerHTML = '';
}

// ── Excel sheet picker modal ────────────────────────────────────
// Lets the user choose which sheets of a multi-sheet workbook actually get
// sent to the model — useful for excluding helper sheets that only exist
// to back dropdown / data-validation lists elsewhere in the file.
// Resolves to an array of selected sheet names (possibly empty if the user
// unchecks everything), or null if the user cancelled.
function _showSheetPickerModal(filename, sheets, preselected) {
  return new Promise((resolve) => {
    const preselectedSet = new Set(
      preselected && preselected.length ? preselected : sheets.map(s => s.name)
    );

    const overlay = document.createElement('div');
    overlay.className = 'modal xlsx-sheet-modal';

    const content = document.createElement('div');
    content.className = 'modal-content xlsx-sheet-modal-content';
    overlay.appendChild(content);

    const header = document.createElement('div');
    header.className = 'pane-header';
    const title = document.createElement('span');
    title.className = 'pane-title';
    title.textContent = `Select sheets — ${filename}`;
    header.appendChild(title);
    content.appendChild(header);

    const body = document.createElement('div');
    body.className = 'modal-body xlsx-sheet-modal-body';
    content.appendChild(body);

    const list = document.createElement('div');
    list.className = 'xlsx-sheet-list';
    body.appendChild(list);

    const checkboxes = []; // [{ name, cb }]
    for (const sheet of sheets) {
      const row = document.createElement('label');
      row.className = 'xlsx-sheet-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = preselectedSet.has(sheet.name);
      checkboxes.push({ name: sheet.name, cb });
      row.appendChild(cb);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'xlsx-sheet-name';
      nameSpan.textContent = sheet.name;
      row.appendChild(nameSpan);

      const metaSpan = document.createElement('span');
      metaSpan.className = 'xlsx-sheet-meta';
      const rows = sheet.rows ?? '?';
      const cols = sheet.cols ?? '?';
      metaSpan.textContent = `${rows} × ${cols}`;
      row.appendChild(metaSpan);

      list.appendChild(row);
    }

    const footer = document.createElement('div');
    footer.className = 'xlsx-sheet-modal-footer';
    content.appendChild(footer);

    const allBtn = document.createElement('button');
    allBtn.className = 'btn-ghost';
    allBtn.textContent = 'select all';
    allBtn.addEventListener('click', () => checkboxes.forEach(c => { c.cb.checked = true; }));
    footer.appendChild(allBtn);

    const noneBtn = document.createElement('button');
    noneBtn.className = 'btn-ghost';
    noneBtn.textContent = 'select none';
    noneBtn.addEventListener('click', () => checkboxes.forEach(c => { c.cb.checked = false; }));
    footer.appendChild(noneBtn);

    const spacer = document.createElement('span');
    spacer.className = 'xlsx-sheet-modal-spacer';
    footer.appendChild(spacer);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-ghost';
    cancelBtn.textContent = 'cancel';
    footer.appendChild(cancelBtn);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-primary';
    confirmBtn.textContent = 'Convert';
    footer.appendChild(confirmBtn);

    function close(result) {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(result);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') close(null);
    }

    cancelBtn.addEventListener('click', () => close(null));
    confirmBtn.addEventListener('click', () => {
      const selected = checkboxes.filter(c => c.cb.checked).map(c => c.name);
      close(selected);
    });
    // Click on the dimmed backdrop (not the modal content) = cancel.
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKeydown);

    document.body.appendChild(overlay);
  });
}

// Reopen the sheet picker for an already-converted Excel attachment so the
// user can revise their selection (e.g. they spot a dropdown-source sheet
// they forgot to exclude) without re-attaching the file from scratch.
async function _reopenSheetPicker(attIdx) {
  const att = chatAttachments[attIdx];
  if (!att || !Array.isArray(att._xlsxAllSheets) || !att.file) return;

  const currentSelection = att._xlsxSelectedSheets || att._xlsxAllSheets.map(s => s.name);
  const picked = await _showSheetPickerModal(att.file.name, att._xlsxAllSheets, currentSelection);
  if (picked === null) return; // cancelled — leave the attachment exactly as it was

  const unchanged = picked.length === currentSelection.length &&
                     picked.every(n => currentSelection.includes(n));
  if (unchanged) return;

  att._xlsxSelectedSheets = picked;
  att._processing = true;
  att._statusMsg  = 'Re-converting…';
  att._error      = null;
  _refreshChip(attIdx);

  _attachProcessing++;
  try {
    const formData = new FormData();
    formData.append('file', att.file);
    if (picked.length < att._xlsxAllSheets.length) {
      formData.append('sheets', JSON.stringify(picked));
    }
    const resp = await fetch('/api/convert-file', {
      method: 'POST',
      headers: { 'X-Client-ID': CLIENT_ID },
      body: formData,
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    att.text       = data.markdown || '(no content extracted)';
    att._statusMsg = null;
  } catch (err) {
    att._error = '⚠ conversion failed';
    console.error('Excel re-conversion error:', err);
  } finally {
    att._processing = false;
    _attachProcessing--;
    _refreshChip(attIdx);
  }
}

chatAttachBtn?.addEventListener('click', () => {
  chatFileInput.removeAttribute('accept');
  chatFileInput.click();
});

chatFileInput?.addEventListener('change', async () => {
  const files = Array.from(chatFileInput.files || []);
  if (!files.length) return;

  for (const file of files) {
    const isImage  = file.type.startsWith('image/');
    const isPdf    = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    // xlsx/xls get their own branch below (sheet picker + NaN-free conversion);
    // everything else still goes through the generic MarkItDown office path.
    const isExcel  = /\.(xlsx|xls)$/i.test(file.name);
    const isOffice = /\.(docx|pptx|zip)$/i.test(file.name);

    const att = { file, type: null, b64: null, text: null, _label: file.name };

    if (isImage) {
      att.type = 'image';
      att.b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

    } else if (isPdf) {
      // ── PDF: extract text + render each page to a PNG for vision models ──
      att.type        = 'pdf';
      att._processing = true;
      att._statusMsg  = 'Opening PDF…';
      att._progress   = null;
      const attIdx = chatAttachments.length; // index this attachment will occupy
      chatAttachments.push(att);
      _renderAttachChips();
      chatAttachPreview?.classList.remove('hidden');
      chatAttachBtn?.classList.add('has-file');

      _attachProcessing++;
      try {
        if (typeof pdfjsLib === 'undefined')
          throw new Error('PDF.js not loaded — add lib/pdf.min.js to index.html');

        const arrayBuffer = await file.arrayBuffer();
        att._statusMsg = 'Parsing structure…';
        _refreshChip(attIdx);
        const pdfDoc      = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const numPages    = pdfDoc.numPages;
        att._statusMsg = `Reading page 1 of ${numPages}…`;
        att._progress  = { done: 0, total: numPages };
        _refreshChip(attIdx);

        // ── Per-page visual scoring ───────────────────────────────────
        // Decides whether a page should be sent to the model as an image,
        // text, or both.  A simple "has text → text only" heuristic fails for
        // technical drawings (CAD plans, schematics, charts) which carry text
        // as labels but whose meaning is entirely spatial/visual.
        //
        // Three signals combined into visualScore ∈ [0, 1]:
        //
        //   S1 – Graphics operator density  (weight 0.70)
        //        Count of path-construction / fill / stroke / image-XObject ops
        //        from getOperatorList(), saturated at 200.
        //        This is the dominant signal: a prose PDF has <20 path ops
        //        (page borders, maybe a header rule). A CAD drawing has hundreds.
        //        NOTE: S3 (short-token ratio) was removed — pdf.js tokenises text
        //        into small runs so almost every PDF (even prose) scores high on
        //        short tokens, making it an unreliable discriminator.
        //
        //   S2 – Text item count penalty    (weight 0.20, inverted)
        //        Prose pages have many text items; drawings have few relative to
        //        page content.  score = 1 − min(itemCount / 150, 1).
        //
        //   S4 – Embedded raster images     (weight 0.10)
        //        1 if any paintJpegXObject / paintImageXObject op found, else 0.
        //        Catches scanned pages that slip through S1.
        //
        // Threshold 0.35: pages scoring above it are sent as images to the model.
        const _PDF_VISUAL_THRESHOLD = 0.35;

        // OPS codes from pdf.js that indicate path / graphics / image drawing.
        // Source: pdf.js/src/shared/util.js — OPS enum.
        const _GRAPHIC_OPS = new Set([
          // Path construction
          82,  // moveTo
          83,  // lineTo
          84,  // curveBezierCT (curveTo)
          85,  // curveBezierQT
          86,  // rectangle
          // Path painting
          87,  // closePath
          88,  // stroke
          89,  // closeStroke
          90,  // fill
          91,  // eoFill
          92,  // fillStroke
          93,  // eoFillStroke
          94,  // closeFillStroke
          95,  // closeEOFillStroke
          // Image / XObject
          23,  // paintJpegXObject
          24,  // paintImageXObject
          26,  // paintInlineImageXObject
          77,  // paintXObject  (Form XObjects — may include sub-drawings)
        ]);

        let   fullText   = '';
        const pageImages = []; // ALL pages — for thumbnails + _pdfPages sidecar
        const visualPages = []; // PNGs for pages whose visualScore exceeds threshold

        for (let p = 1; p <= numPages; p++) {
          att._statusMsg = `Processing ${p} of ${numPages}…`;
          att._progress  = { done: p - 1, total: numPages };
          _refreshChip(attIdx);
          const page = await pdfDoc.getPage(p);

          // ── S1: graphics operator count ──────────────────────────────
          let graphicOpCount = 0;
          let hasEmbeddedImage = false;
          try {
            const opList = await page.getOperatorList();
            for (const op of opList.fnArray) {
              if (_GRAPHIC_OPS.has(op)) graphicOpCount++;
              if (op === 23 || op === 24 || op === 26) hasEmbeddedImage = true;
            }
          } catch { /* getOperatorList can fail on malformed PDFs — treat as 0 */ }

          // ── S2: text layer analysis ──────────────────────────────────
          const textContent = await page.getTextContent();
          const items = textContent.items.filter(item => 'str' in item);

          // ── S2: text item count (inverted — more items = more prose-like) ──
          const itemDensity = items.length > 0 ? Math.min(items.length / 150, 1) : 0;

          const pageText = items
            .map(item => item.str)
            .join(' ')
            .replace(/ {2,}/g, ' ')
            .trim();
          if (pageText) fullText += `\n--- Page ${p} ---\n${pageText}`;

          // ── Render page to PNG (always — needed for thumbnails / sidecar) ──
          const hiViewport = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement('canvas');
          canvas.width  = hiViewport.width;
          canvas.height = hiViewport.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: hiViewport }).promise;
          const pngB64 = canvas.toDataURL('image/png').split(',')[1];
          pageImages.push(pngB64);

          // Update progress after page is rendered
          att._progress = { done: p, total: numPages };
          if (p < numPages) att._statusMsg = `Rendering page ${p + 1} of ${numPages}…`;
          _refreshChip(attIdx);

          // ── Combine signals into visualScore ──────────────────────────
          // Special case: no text items at all → unconditionally visual.
          // Covers scanned/raster PDFs where pdf.js extracts nothing.
          if (items.length === 0) {
            visualPages.push(pngB64);
          } else {
            // S1: dominant signal — saturate at 200 path/graphics ops
            const s1 = Math.min(graphicOpCount / 200, 1);
            // S2: inverted item density — fewer items = more drawing-like
            const s2 = 1 - itemDensity;
            // S4: embedded raster image present
            const s4 = hasEmbeddedImage ? 1 : 0;

            const visualScore = s1 * 0.70 + s2 * 0.20 + s4 * 0.10;

            if (visualScore >= _PDF_VISUAL_THRESHOLD) visualPages.push(pngB64);
          }
        }

        att.text         = fullText.trim();
        att.pageImages   = pageImages;   // all pages — for thumbnails + _pdfPages sidecar
        att.visualPages  = visualPages;  // vision-worthy pages — sent to model as images
        att.pageCount    = numPages;
        att._label       = `${file.name}  (${numPages} page${numPages !== 1 ? 's' : ''})`;
        att._processing  = false;
        att._statusMsg   = null;
        att._progress    = null;
      } catch (err) {
        att.text        = '(PDF could not be read)';
        att.pageImages  = [];
        att.visualPages = [];
        att._label      = `${file.name}  ⚠ read failed`;
        att._processing = false;
        att._error      = '⚠ read failed';
        console.error('PDF processing error:', err);
      } finally {
        _attachProcessing--;
      }
      _refreshChip(attIdx);
      continue; // already pushed above

    } else if (isExcel) {
      // ── Excel: peek sheet names first, let the user pick which to keep
      // (helper/dropdown-source sheets are common and just waste tokens),
      // then convert via the backend's NaN-free, sheet-filtered path. ──
      att.type        = 'text';
      att._processing = true;
      att._statusMsg  = 'Reading sheet list…';
      const attIdxXlsx = chatAttachments.length;
      chatAttachments.push(att);
      _renderAttachChips();
      chatAttachPreview?.classList.remove('hidden');
      chatAttachBtn?.classList.add('has-file');

      let cancelled = false;
      _attachProcessing++;
      try {
        const peekForm = new FormData();
        peekForm.append('file', file);
        const peekResp = await fetch('/api/xlsx-sheets', {
          method: 'POST',
          headers: { 'X-Client-ID': CLIENT_ID },
          body: peekForm,
        });
        const peekData = await peekResp.json();
        if (peekData.error) throw new Error(peekData.error);

        const allSheets = peekData.sheets || [];
        att._xlsxAllSheets = allSheets; // kept so the chip toggle can reopen the picker later

        let selected = allSheets.map(s => s.name);
        if (allSheets.length > 1) {
          // Pause the "processing" spinner while waiting on the user, not the network.
          att._processing = false;
          _refreshChip(attIdxXlsx);
          const picked = await _showSheetPickerModal(file.name, allSheets, selected);
          att._processing = true;
          if (picked === null) cancelled = true;
          else selected = picked;
        }

        if (!cancelled) {
          att._xlsxSelectedSheets = selected;
          att._statusMsg = 'Converting…';
          _refreshChip(attIdxXlsx);

          const formData = new FormData();
          formData.append('file', file);
          // Only send the filter when it actually excludes something —
          // keeps the request identical to the all-sheets case otherwise.
          if (selected.length < allSheets.length) {
            formData.append('sheets', JSON.stringify(selected));
          }
          const resp = await fetch('/api/convert-file', {
            method: 'POST',
            headers: { 'X-Client-ID': CLIENT_ID },
            body: formData,
          });
          const data = await resp.json();
          if (data.error) throw new Error(data.error);
          att.text        = data.markdown || '(no content extracted)';
          att._processing = false;
          att._statusMsg  = null;
        }
      } catch (err) {
        att.text        = '(could not convert file)';
        att._processing = false;
        att._error      = '⚠ conversion failed';
        console.error('Excel conversion error:', err);
      } finally {
        _attachProcessing--;
      }

      if (cancelled) {
        chatAttachments.splice(attIdxXlsx, 1);
        if (!chatAttachments.length) {
          chatAttachPreview?.classList.add('hidden');
          chatAttachBtn?.classList.remove('has-file');
        } else {
          _renderAttachChips();
        }
        continue;
      }

      _refreshChip(attIdxXlsx);
      continue; // already pushed above

    } else if (isOffice) {
      // ── Office / structured formats: convert via backend MarkItDown ──
      // Handles .docx, .pptx, .csv, .xml, .json, .zip (xlsx/xls handled above)
      att.type        = 'text';
      att._processing = true;
      att._statusMsg  = 'Converting…';
      const attIdxOffice = chatAttachments.length;
      chatAttachments.push(att);
      _renderAttachChips();
      chatAttachPreview?.classList.remove('hidden');
      chatAttachBtn?.classList.add('has-file');

      _attachProcessing++;
      try {
        const formData = new FormData();
        formData.append('file', file);
        const resp = await fetch('/api/convert-file', {
          method: 'POST',
          headers: { 'X-Client-ID': CLIENT_ID },
          body: formData,
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        att.text        = data.markdown || '(no content extracted)';
        att._processing = false;
        att._statusMsg  = null;
      } catch (err) {
        att.text        = '(could not convert file)';
        att._processing = false;
        att._error      = '⚠ conversion failed';
        console.error('MarkItDown conversion error:', err);
      } finally {
        _attachProcessing--;
      }
      _refreshChip(attIdxOffice);
      continue; // already pushed above

    } else {
      att.type = 'text';
      try { att.text = await file.text(); }
      catch { att.text = '(could not read file)'; }
    }

    chatAttachments.push(att);
  }

  _renderAttachChips();
  chatAttachPreview?.classList.remove('hidden');
  chatAttachBtn?.classList.add('has-file');
  chatFileInput.value = ''; // reset so re-selecting same files fires change again
});

// ── Drag-and-drop file attachment ─────────────────────────────
// A full-screen overlay appears when the user drags a file over the window
// while in chat mode. Dropping feeds files into the same processing pipeline
// as the file-input button (chatFileInput change handler).
(function _initChatDragDrop() {


  // ── Inject overlay DOM ──
  const _overlay = document.createElement('div');
  _overlay.id = 'chat-drop-overlay';
  _overlay.innerHTML = `
    <div id="chat-drop-overlay-label">
      <svg width="52" height="52" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="1.5"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      Drop files to attach
    </div>
  `;
  document.body.appendChild(_overlay);

  // ── Drag counter — tracks nested enter/leave events ──
  // dragenter fires for every child element; a simple boolean would flicker.
  let _dragDepth = 0;

  function _show() { _overlay.classList.add('active'); }
  function _hide() { _overlay.classList.remove('active'); _dragDepth = 0; }

  // ── Process a FileList through the existing attachment pipeline ──
  // Simulates a file-input change event so all type detection, PDF
  // extraction, and MarkItDown conversion code runs without duplication.
  async function _processDroppedFiles(fileList) {
    if (!fileList || !fileList.length) return;

    // Reuse the existing DataTransfer trick to assign files to the hidden input.
    // This keeps the processing 100 % identical to button-based attachment.
    try {
      const dt = new DataTransfer();
      for (const f of fileList) dt.items.add(f);
      chatFileInput.files = dt.files;
      chatFileInput.dispatchEvent(new Event('change'));
    } catch {
      // DataTransfer assignment not supported (very old browsers) — fall back
      // to dispatching a synthetic change with files accessible via a closure.
      // We temporarily monkey-patch files so the existing handler can read them.
      const _origFiles = chatFileInput.files;
      Object.defineProperty(chatFileInput, 'files', {
        configurable: true,
        get: () => fileList,
      });
      chatFileInput.dispatchEvent(new Event('change'));
      // Restore after the (synchronous) event dispatch
      Object.defineProperty(chatFileInput, 'files', {
        configurable: true,
        get: () => _origFiles,
      });
    }
  }

  // ── Event listeners on document ──
  document.addEventListener('dragenter', (e) => {
    if (currentMode !== 'chat') return;
    // Only activate for file drags, not text selections etc.
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    _dragDepth++;
    _show();
  });

  document.addEventListener('dragover', (e) => {
    if (currentMode !== 'chat') return;
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); // required to allow drop
    e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('dragleave', (e) => {
    if (currentMode !== 'chat') return;
    _dragDepth--;
    if (_dragDepth <= 0) _hide();
  });

  document.addEventListener('drop', (e) => {
    if (currentMode !== 'chat') return;
    e.preventDefault();
    _hide();
    const files = e.dataTransfer?.files;
    if (files && files.length) _processDroppedFiles(files);
  });

})();

// ── Clipboard paste attachment ────────────────────────────────
// Handles Cmd/Ctrl+V when the chat input (or document) is focused.
// Supports:
//   • Screenshots / images copied from screen-capture tools (Mac ⌘⇧4,
//     Windows Snipping Tool, etc.) — clipboard item type 'image/*'
//   • Image files copied from Finder / Explorer
//   • Regular files copied from the OS file manager
// Text pastes are left alone so normal Cmd+V into the textarea keeps working.
(function _initChatPaste() {

  // Reuse the same DataTransfer-based pipeline as drag-and-drop.
  async function _processClipboardItems(items) {
    const fileList = [];

    for (const item of items) {
      // ── Image blobs (screenshots, copied images) ──────────────────
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (!blob) continue;
        // Give the pasted image a meaningful filename with the right extension.
        const ext  = item.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        const ts   = new Date().toISOString().slice(0, 19).replace(/[:T]/g, (c) => c === 'T' ? '_' : '-');
        const name = `screenshot_${ts}.${ext}`;
        // Blob → File so the attachment chip shows a filename.
        fileList.push(new File([blob], name, { type: item.type }));
        continue;
      }

      // ── Any other file kind (PDF, Office, text) ───────────────────
      if (item.kind === 'file') {
        const blob = item.getAsFile();
        if (blob) fileList.push(blob); // blob.name already set by the OS
        continue;
      }

      // ── Plain text — leave for the textarea to handle natively ────
      // (kind === 'string') → do nothing; the browser handles it.
    }

    if (!fileList.length) return;

    // Feed into the existing attachment pipeline via the hidden file input.
    try {
      const dt = new DataTransfer();
      for (const f of fileList) dt.items.add(f);
      chatFileInput.files = dt.files;
      chatFileInput.dispatchEvent(new Event('change'));
    } catch {
      // Fallback for browsers that block FileList assignment.
      const _origFiles = chatFileInput.files;
      Object.defineProperty(chatFileInput, 'files', {
        configurable: true,
        get: () => {
          const fakeList = { length: fileList.length, item: i => fileList[i] };
          for (let i = 0; i < fileList.length; i++) fakeList[i] = fileList[i];
          return fakeList;
        },
      });
      chatFileInput.dispatchEvent(new Event('change'));
      Object.defineProperty(chatFileInput, 'files', {
        configurable: true,
        get: () => _origFiles,
      });
    }
  }

  document.addEventListener('paste', (e) => {
    if (currentMode !== 'chat') return;

    const items = Array.from(e.clipboardData?.items || []);

    // If there are no file/image items, let the browser handle the paste
    // normally (i.e. plain text into the textarea).
    const hasFileItem = items.some(it => it.kind === 'file');
    if (!hasFileItem) return;

    // There is at least one file — intercept so we can attach it.
    e.preventDefault();
    _processClipboardItems(items);
  });

})();

// ── LaTeX + Markdown renderer ─────────────────────────────────
function renderMarkdownWithLatex(content) {
  const tokens = [];
  const PLACEHOLDER = (i) => `\x02MATH${i}\x03`;

  // ── Tool-generated image tags — <jarvis_img id="..."> ──────────
  // Swapped out before marked.parse() (same technique as the math
  // placeholders below) so marked never touches the raw tag. Inserted whole
  // by chat.js's tool-call loop, never streamed token-by-token, so no
  // partial-tag handling is needed (unlike fileblocks.js's <jarvis_file>).
  const imgTokens = [];
  const IMG_PLACEHOLDER = (i) => `\x02JIMG${i}\x03`;
  let withImages = content.replace(
    /<jarvis_img\s+id="([^"]+)"\s*\/?>(?:\s*<\/jarvis_img>)?/g,
    (_, id) => { const idx = imgTokens.length; imgTokens.push(id); return IMG_PLACEHOLDER(idx); }
  );
  // Loading shimmer placeholder — shown while generate_image is in flight,
  // swapped out for the real <jarvis_img> tag once the tool call resolves
  // (see the tool-call loop below). No id/data lookup needed — purely
  // decorative — so it's kept as its own trivial tag rather than an
  // attribute variant of <jarvis_img>.
  const LOADING_PLACEHOLDER = `\x02JIMGLOADING\x03`;
  withImages = withImages.replace(/<jarvis_img_loading\s*\/?>(?:\s*<\/jarvis_img_loading>)?/g, LOADING_PLACEHOLDER);

  const mathPatterns = [
    { re: /\$\$([\s\S]+?)\$\$/g,        display: true  },
    { re: /\\\[([\s\S]+?)\\\]/g,         display: true  },
    { re: /\\\((.+?)\\\)/g,             display: false },
    { re: /(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, display: false },
  ];

  let processed = withImages;
  for (const { re, display } of mathPatterns) {
    processed = processed.replace(re, (match, math) => {
      const idx = tokens.length;
      tokens.push({ math: math.trim(), display });
      return PLACEHOLDER(idx);
    });
  }

  let html = marked.parse(processed);

  html = html.replace(/\x02MATH(\d+)\x03/g, (_, i) => {
    const { math, display } = tokens[parseInt(i, 10)];
    try {
      return katex.renderToString(math, { displayMode: display, throwOnError: false, output: 'html' });
    } catch (e) {
      return `<span class="katex-error" title="${e.message}">${display ? '$$' + math + '$$' : '$' + math + '$'}</span>`;
    }
  });

  html = html.replace(/\x02JIMG(\d+)\x03/g, (_, i) => _renderToolImageTag(imgTokens[parseInt(i, 10)]));

  html = html.replace(/\x02JIMGLOADING\x03/g,
    `<div class="tool-img-loading"><div class="tool-img-loading-label">${_chatImgProgressText()}</div></div>`);

  return html;
}

function attachCodeCopyButtons(container) {
  container.querySelectorAll('pre').forEach(block => {
    if (block.querySelector('.code-copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
    btn.onclick = async () => {
      const codeEl = block.querySelector('code') || block;
      const text = codeEl.innerText ?? codeEl.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch {}
        ta.remove();
      }
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1500);
    };
    block.appendChild(btn);
  });
}

// ── Chat lightbox helper ──────────────────────────────────────
// Collects every image tagged with data-chat-lb-src from the entire chat
// (in DOM order), then opens the shared lightbox from image.js at the
// position of the clicked element.  Falls back gracefully if image.js
// is not yet loaded (e.g. during very early rendering).
function _openChatLightboxAt(clickedImgEl) {
  if (typeof openChatLightbox !== 'function') return;
  const all = [...chatMessagesEl.querySelectorAll('img[data-chat-lb-src]')];
  const total = all.length;
  const sources = all.map((el, i) => {
    const name = el.dataset.chatLbLabel || '';
    // Embed position into label so the numeric pill counter isn't needed
    const label = total > 1
      ? (name ? `${name}  ·  ${i + 1} / ${total}` : `${i + 1} / ${total}`)
      : name;
    return { src: el.dataset.chatLbSrc, label };
  });
  const startIdx = Math.max(0, all.indexOf(clickedImgEl));
  openChatLightbox(sources, startIdx);
}

// ── iOS-safe tap handler ─────────────────────────────────────
// iOS Safari delays or drops 'click' events on elements inside overflow:auto
// scroll containers when a touchstart listener exists on the container.
// Using touchend directly bypasses this — it fires immediately on finger lift
// with no scroll-detection delay. preventDefault() stops the subsequent
// synthetic click so the handler doesn't fire twice on desktop.
function _addTapHandler(el, fn) {
  let _touchMoved = false;
  el.addEventListener('touchstart', () => { _touchMoved = false; }, { passive: true });
  el.addEventListener('touchmove',  () => { _touchMoved = true;  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (_touchMoved) return;          // was a scroll, not a tap
    e.preventDefault();               // suppress the delayed synthetic click
    fn();
  }, { passive: false });
  el.addEventListener('click', fn);   // desktop fallback
}

function addBubble(role, content, streaming = false, imageUrl = null, attachmentInfo = null) {
  chatEmpty.style.display = 'none';
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = role === 'user' ? 'You' : 'Model';

  if (role === 'assistant') {
    const thinkWrap   = document.createElement('div');
    thinkWrap.className = 'msg-think hidden';
    const thinkHeader = document.createElement('div');
    thinkHeader.className = 'think-header';
    thinkHeader.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><circle cx="12" cy="12" r="10"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>Thinking</span><span class="think-spinner"></span><svg class="think-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>`;
    const thinkEl = document.createElement('div');
    thinkEl.className = 'think-body';
    thinkHeader.addEventListener('click', () => thinkWrap.classList.toggle('think-collapsed'));
    thinkWrap.appendChild(thinkHeader);
    thinkWrap.appendChild(thinkEl);
    wrap.appendChild(thinkWrap);
    wrap._thinkWrap   = thinkWrap;
    wrap._thinkEl     = thinkEl;
    wrap._thinkSpinner = thinkHeader.querySelector('.think-spinner');
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble._rawContent = content;

  if (role === 'assistant') {
    bubble.innerHTML = renderMarkdownWithLatex(content);
    attachCodeCopyButtons(bubble);
  } else {
    // attachmentInfo may be a single object or an array; imageUrl is legacy single-image path
    const attList = Array.isArray(attachmentInfo) ? attachmentInfo
                  : attachmentInfo ? [attachmentInfo] : [];

    // All chip/thumbnail elements go into a dedicated container.
    // This lets updateBubble (and fileblocks.js's patched version) safely
    // replace only the text portion of the bubble without destroying the chips.
    const chipsContainer = document.createElement('div');
    chipsContainer.className = 'msg-bubble-chips';

    if (imageUrl && !attList.length) {
      const imgEl = document.createElement('img');
      imgEl.src = imageUrl; imgEl.className = 'msg-attachment-thumb'; imgEl.alt = 'attached image';
      // Store lightbox src in a separate dataset key so the thumbnail <img>
      // never has this URL as its .src — prevents iOS from caching the decoded
      // bitmap at thumbnail dimensions and serving it to the lightbox instead
      // of doing a fresh full-resolution decode.
      imgEl.dataset.chatLbSrc   = imageUrl;
      imgEl.dataset.chatLbLabel = '';
      imgEl.style.cursor = 'zoom-in';
      _addTapHandler(imgEl, () => _openChatLightboxAt(imgEl));
      chipsContainer.appendChild(imgEl);
    } else {
      for (const info of attList) {
        const chip = document.createElement('div');
        chip.className = 'msg-attachment-chip';
        if (info.type === 'image' && info.objectUrl) {
          chip.className = 'msg-attachment-img-chip';
          const imgEl = document.createElement('img');
          imgEl.src = info.objectUrl;
          imgEl.className = 'msg-attachment-img-chip-thumb';
          imgEl.alt = info.name;
          imgEl.dataset.chatLbLabel = info.name || '';
          imgEl.style.cursor = 'zoom-in';
          // Use lbUrl — a second fresh blob URL created from the same file as
          // objectUrl. iOS Safari caches decoded bitmaps by URL string; a new
          // blob URL has no cache entry so iOS decodes it at full resolution.
          // Falls back to dataUri (for cases where file is available but lbUrl
          // wasn't stored), then objectUrl (restored-from-DB path where objectUrl
          // is already a data-URI, not a blob, so it is safe as a last resort).
          imgEl.dataset.chatLbSrc = info.lbUrl || info.dataUri || info.objectUrl;
          _addTapHandler(imgEl, () => _openChatLightboxAt(imgEl));
          chip.appendChild(imgEl);
          const meta = document.createElement('div');
          meta.className = 'msg-attachment-img-chip-meta';
          const nameEl = document.createElement('span');
          nameEl.className = 'msg-attachment-img-chip-name';
          nameEl.textContent = info.name;
          meta.appendChild(nameEl);
          if (info.size != null) {
            const sizeEl = document.createElement('span');
            sizeEl.className = 'msg-attachment-img-chip-size';
            sizeEl.textContent = info.size < 1024 * 1024
              ? `${(info.size / 1024).toFixed(1)} KB`
              : `${(info.size / (1024 * 1024)).toFixed(2)} MB`;
            meta.appendChild(sizeEl);
          }
          chip.appendChild(meta);
          chipsContainer.appendChild(chip);
        } else if (info.type === 'pdf') {
          // ── PDF: never show a redundant file chip alongside the real content ──
          //
          // Vision PDF (has page images) → page thumbnails are the UI; no chip.
          // Text-only PDF                → the <jarvis_file> card rendered by
          //                                fileblocks.js is the UI; no chip.
          // Read failure (no images, no text, label contains ⚠) → keep a minimal
          //   error chip so the user knows something went wrong.
          // Derive the effective send mode, mirroring the logic in applyAttachment:
          //   visualOverride === true  → always image (even if the PDF has text)
          //   visualOverride === false → always text  (even if the PDF has no text)
          //   null / undefined         → use scorer default: image when !hasText
          const _pdfEffectiveImage = info.visualOverride === true  ? true
                                   : info.visualOverride === false ? false
                                   : !info.hasText;
          if (info.pageImages && info.pageImages.length && _pdfEffectiveImage) {
            // ── Vision PDF: one summary chip per file ─────────────────────────
            // Shown when the effective send mode is image — either because the
            // PDF has no extractable text (scanned/image-only) or because the
            // user forced image mode via the toggle.
            // Text PDFs in text mode are excluded — fileblocks.js renders a
            // <jarvis_file> card for them; thumbnails would be a duplicate.
            // We show a single chip using page 1 as the preview thumbnail plus
            // the filename and page count.  All page images are still stored in
            // IndexedDB (_pdfPages) so the model keeps full vision context.
            const summaryChip = document.createElement('div');
            summaryChip.className = 'msg-attachment-img-chip msg-pdf-page-chip';
            const imgEl = document.createElement('img');
            imgEl.src = `data:image/png;base64,${info.pageImages[0]}`;
            imgEl.className = 'msg-attachment-img-chip-thumb';
            imgEl.alt = info.name || 'PDF';
            // PDF: clicking the thumb opens ALL pages in the lightbox
            const pdfName = info.name || 'document.pdf';
            const pdfSources = info.pageImages.map((b64, pi) => ({
              src:   `data:image/png;base64,${b64}`,
              label: `${pdfName} — page ${pi + 1} / ${info.pageImages.length}`,
            }));
            imgEl.style.cursor = 'zoom-in';
            _addTapHandler(imgEl, () => {
              if (typeof openChatLightbox === 'function') openChatLightbox(pdfSources, 0);
            });
            summaryChip.appendChild(imgEl);
            const meta = document.createElement('div');
            meta.className = 'msg-attachment-img-chip-meta';
            const nameEl = document.createElement('span');
            nameEl.className = 'msg-attachment-img-chip-name';
            nameEl.textContent = info.name || 'document.pdf';
            meta.appendChild(nameEl);
            const pageCountEl = document.createElement('span');
            pageCountEl.className = 'msg-attachment-img-chip-size';
            pageCountEl.textContent = `${info.pageImages.length} page${info.pageImages.length !== 1 ? 's' : ''}`;
            meta.appendChild(pageCountEl);
            summaryChip.appendChild(meta);
            chipsContainer.appendChild(summaryChip);
          } else if (info.name && info.name.includes('⚠')) {
            // ── Read failure: show error chip ─────────────────────────────────
            const pdfIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#e84040" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>`;
            chip.innerHTML = pdfIcon + `<span>${info.name}</span>`;
            chipsContainer.appendChild(chip);
          }
          // else: text-only PDF — no chip; <jarvis_file> card handles the display
        } else {
          const icon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
          chip.innerHTML = icon + `<span>${info.name}</span>`;
          chipsContainer.appendChild(chip);
        }
      }
    }
    // Chips container goes first (before the text), so fileblocks.js can
    // replace only .msg-bubble-text without touching the chip elements.
    if (chipsContainer.hasChildNodes()) {
      bubble.appendChild(chipsContainer);
      // Store reference so updateBubble can re-inject chips if fileblocks.js
      // replaces the whole bubble innerHTML.
      bubble._chipsContainer = chipsContainer;
    }
    const textDiv = document.createElement('div');
    textDiv.className = 'msg-bubble-text';
    textDiv.textContent = content;
    bubble.appendChild(textDiv);
  }

  if (streaming) { const c = document.createElement('span'); c.className = 'stream-cursor'; bubble.appendChild(c); }

  const copyBubbleBtn = document.createElement('button');
  copyBubbleBtn.className = 'bubble-copy-btn';
  copyBubbleBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
  copyBubbleBtn.onclick = () => {
    navigator.clipboard.writeText(bubble._rawContent);
    copyBubbleBtn.style.color = 'var(--green)';
    setTimeout(() => copyBubbleBtn.style.color = '', 1000);
  };

  wrap.appendChild(label);
  wrap.appendChild(bubble);
  wrap.appendChild(copyBubbleBtn);
  chatMessagesEl.appendChild(wrap);

  if (shouldAutoScroll) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  return bubble;
}

function updateBubble(bubble, content, streaming = true) {
  bubble._rawContent = content;
  if (bubble.parentElement.classList.contains('assistant')) {
    bubble.innerHTML = renderMarkdownWithLatex(content);
    attachCodeCopyButtons(bubble);
  } else {
    // For user bubbles, only replace the text node (.msg-bubble-text), NOT the
    // whole bubble.  Wiping bubble.textContent/innerHTML destroys attachment chip
    // elements (page thumbnails, image chips) that live in .msg-bubble-chips.
    // fileblocks.js patches this function and may set bubble.innerHTML directly;
    // we re-inject the chips container afterwards if it was evicted.
    const textNode = bubble.querySelector('.msg-bubble-text');
    if (textNode) {
      textNode.textContent = content;
    } else {
      // fileblocks.js (or a legacy path) replaced the whole innerHTML.
      // Rebuild the text node and re-inject the chips container.
      const newText = document.createElement('div');
      newText.className = 'msg-bubble-text';
      newText.textContent = content;
      bubble.appendChild(newText);
    }
    // Re-inject chips container if it was evicted by an innerHTML replacement.
    if (bubble._chipsContainer && !bubble.contains(bubble._chipsContainer)) {
      bubble.insertBefore(bubble._chipsContainer, bubble.firstChild);
    }
  }
  if (streaming) { const c = document.createElement('span'); c.className = 'stream-cursor'; bubble.appendChild(c); }
  if (shouldAutoScroll) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function updateThinkBubble(bubble, thinkText, streaming = true) {
  const wrap = bubble.parentElement;
  if (!wrap || !wrap._thinkWrap) return;
  const thinkWrap    = wrap._thinkWrap;
  const thinkEl      = wrap._thinkEl;
  const thinkSpinner = wrap._thinkSpinner;

  if (!thinkText) { thinkWrap.classList.add('hidden'); return; }

  thinkWrap.classList.remove('hidden');
  thinkEl.textContent = thinkText;

  if (thinkSpinner) thinkSpinner.classList.toggle('visible', streaming);

  if (streaming) {
    // Keep expanded while streaming so the user can see live output,
    // and pin the scrollable body to the bottom so the latest text is always visible.
    thinkWrap.classList.remove('think-collapsed');
    const c = document.createElement('span');
    c.className = 'stream-cursor';
    thinkEl.appendChild(c);
    thinkEl.scrollTop = thinkEl.scrollHeight;
  } else if (thinkText) {
    // Collapse when done — user can click the header to expand.
    thinkWrap.classList.add('think-collapsed');
  }

  if (shouldAutoScroll) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

// ── Response stats helpers ────────────────────────────────────
function parseStats(raw, timing) {
  if (!raw) return null;
  if (API.isOllama())   return OllamaAPI.parseStats(raw, timing);
  if (API.isLMStudio()) return LMStudioAPI.parseStats(raw, timing);
  return OpenAIAPI.parseStats(raw, timing);
}

function renderStatsBar(bubble, stats) {
  if (!SHOW_STATS || !stats) return;
  const wrap = bubble.parentElement;
  if (!wrap) return;
  wrap.querySelector('.msg-stats-bar')?.remove();
  const bar = document.createElement('div');
  bar.className = 'msg-stats-bar';
  const parts = [];
  if (stats.tps          !== undefined) parts.push(`⚡ ${stats.tps} tok/s`);
  if (stats.inputTokens  !== undefined) parts.push(`↑ ${stats.inputTokens} tkn in`);
  if (stats.outputTokens !== undefined) parts.push(`↓ ${stats.outputTokens} tkn out`);
  if (stats.ttft         !== undefined) parts.push(`⏱ TTFT ${stats.ttft}`);
  if (stats.loadTime     !== undefined) parts.push(`🔄 load ${stats.loadTime}`);
  if (stats.totalTime    !== undefined) parts.push(`⏱ total ${stats.totalTime}`);
  bar.textContent = parts.join('  ·  ');
  wrap.appendChild(bar);
  // Update the context usage monitor bar whenever new stats arrive
  updateCtxMonitor(stats, bubble);
}

// ── Context usage monitor ─────────────────────────────────────
// Renders (or updates) a thin progress bar inside the last assistant
// message wrap, directly below the stats bar.  Pass the assistant
// bubble element; the bar is attached to bubble.parentElement (.msg).
//
// Called from renderStatsBar (live) and restoreChat (page reload).
// Passing bubble=null removes any existing bar from the DOM (clearChat).
function updateCtxMonitor(stats, bubble) {
  // ── null → clear any existing bar ────────────────────────────
  if (bubble === null) {
    document.querySelectorAll('.ctx-bar').forEach(el => el.remove());
    return;
  }

  const used = stats && stats.inputTokens !== undefined ? stats.inputTokens : null;
  if (used === null) return;

  // Persist so saveChatHistory() picks it up
  _lastCtxUsed = used;

  // Resolve configured context window from the Settings input
  const ctxInput = document.getElementById('set-ctx');
  const total    = ctxInput ? parseInt(ctxInput.value, 10) : 0;
  if (!total || total <= 0) return; // no denominator — nothing to show

  const wrap = bubble?.parentElement;
  if (!wrap) return;

  // Reuse existing bar if present on this wrap, otherwise create
  let bar  = wrap.querySelector('.ctx-bar');
  let fill = bar?.querySelector('.ctx-bar-fill');
  if (!bar) {
    bar  = document.createElement('div');
    bar.className = 'ctx-bar';
    fill = document.createElement('div');
    fill.className = 'ctx-bar-fill';
    bar.appendChild(fill);
    wrap.appendChild(bar);
  }

  const pct     = Math.min(used / total, 1);
  const pctDisp = (pct * 100).toFixed(1);  // 1 decimal, e.g. "0.4" or "12.7"
  const free    = Math.max(total - used, 0);

  // Human-friendly token count: always show at least one decimal for sub-1k
  function fmtTok(n) {
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  fill.style.width = pctDisp + '%';

  bar.classList.remove('ctx-warn', 'ctx-crit');
  if (pct >= 0.90)      bar.classList.add('ctx-crit');
  else if (pct >= 0.75) bar.classList.add('ctx-warn');

  const freePct = (100 - parseFloat(pctDisp)).toFixed(1);
  bar.title =
    `Context: ${pctDisp}% used · ${fmtTok(used)} of ${fmtTok(total)} tokens\n` +
    `Free: ${freePct}% · ${fmtTok(free)} tokens remaining`;
}

// ── Tool-call UI helpers ──────────────────────────────────────

// Strips model-emitted tool-response artifacts that leak into the text stream
// as plain content.  These appear when some fine-tuned models echo back the
// tool invocation or result as text, e.g.:
//   "<|tool_response>"
//   "<|tool_response>tool { ...full JSON... }"
// Everything from the first "<|tool_response>" token to end-of-string is
// removed; any meaningful text the model produced before that token is kept.
function _stripToolArtifacts(text) {
  const idx = text.indexOf('<|tool_response>');
  if (idx === -1) return text;
  return text.slice(0, idx).trimEnd();
}
// ── Tool-result rendering: expandable JSON tree + text expand/collapse ──
// Tool results are usually JSON (especially RAG search results, which can
// contain several large chunks). Instead of a fixed-length text preview,
// render valid JSON as a collapsible tree (click any object/array to
// expand or collapse it), and fall back to a "Show more/less" toggle for
// plain text so the full result is always reachable, not just a snippet.

function _jsonLeafEl(text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  return span;
}

// Renders one JSON value as a DOM node. Objects/arrays get a clickable
// header that toggles their children; primitives render as plain leaves.
// depth 0-1 start expanded (so top-level fields and e.g. a RAG "results"
// array are visible immediately); depth >= 2 starts collapsed (so a list
// of large chunk objects doesn't dump pages of text by default).
function _renderJsonValue(value, depth) {
  depth = depth || 0;
  if (value === null || value === undefined) return _jsonLeafEl('null', 'jt-null');
  const t = typeof value;
  if (t === 'string')  return _jsonLeafEl(JSON.stringify(value), 'jt-string');
  if (t === 'number')  return _jsonLeafEl(String(value), 'jt-number');
  if (t === 'boolean') return _jsonLeafEl(String(value), 'jt-bool');

  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);

  const wrap = document.createElement('div');
  wrap.className = 'jt-node';
  if (!entries.length) {
    wrap.appendChild(_jsonLeafEl(isArray ? '[]' : '{}', 'jt-empty'));
    return wrap;
  }

  const expanded = depth < 2;
  const header = document.createElement('div');
  header.className = 'jt-header';
  header.style.cssText = 'cursor:pointer;user-select:none;display:flex;align-items:center;gap:4px;';

  const toggle = document.createElement('span');
  toggle.className = 'jt-toggle';
  toggle.textContent = expanded ? '▾' : '▸';
  toggle.style.cssText = 'flex-shrink:0;opacity:0.7;width:10px;';

  const summary = document.createElement('span');
  summary.className = 'jt-summary';
  summary.style.cssText = 'opacity:0.65;';
  summary.textContent = isArray ? `Array(${entries.length})` : `Object {${entries.length}}`;

  header.appendChild(toggle);
  header.appendChild(summary);

  const children = document.createElement('div');
  children.className = 'jt-children';
  children.style.cssText =
    'margin-left:7px;padding-left:9px;border-left:1px solid var(--border);display:' +
    (expanded ? 'block' : 'none') + ';';

  entries.forEach(([k, v]) => {
    const row = document.createElement('div');
    row.className = 'jt-row';
    row.style.cssText = 'padding:1px 0;';
    const keyEl = document.createElement('span');
    keyEl.className = 'jt-key';
    keyEl.style.cssText = 'color:var(--accent);opacity:0.85;';
    keyEl.textContent = (isArray ? `[${k}]` : `"${k}"`) + ': ';
    row.appendChild(keyEl);
    row.appendChild(_renderJsonValue(v, depth + 1));
    children.appendChild(row);
  });

  header.addEventListener('click', () => {
    const open = children.style.display !== 'none';
    children.style.display = open ? 'none' : 'block';
    toggle.textContent = open ? '▸' : '▾';
  });

  wrap.appendChild(header);
  wrap.appendChild(children);
  return wrap;
}

// Plain-text result: full text is always present in the DOM, with a
// "Show more / Show less" toggle when it exceeds the preview length —
// no information is ever dropped, just collapsed.
function _renderToolResultText(text) {
  const full = text || '';
  const PREVIEW_LEN = 800;
  const pre = document.createElement('div');
  pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;';
  pre.textContent = full.length > PREVIEW_LEN ? full.slice(0, PREVIEW_LEN) + '…' : full;
  if (full.length <= PREVIEW_LEN) return pre;

  const wrap = document.createElement('div');
  wrap.appendChild(pre);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Show more';
  btn.style.cssText =
    'margin-top:4px;font-size:0.85em;background:none;border:1px solid var(--border);' +
    'border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--text2);';
  let expanded = false;
  btn.addEventListener('click', () => {
    expanded = !expanded;
    pre.textContent = expanded ? full : full.slice(0, PREVIEW_LEN) + '…';
    btn.textContent = expanded ? 'Show less' : 'Show more';
  });
  wrap.appendChild(btn);
  return wrap;
}

// Entry point: tries to parse the result as JSON and renders a collapsible
// tree when it is one; otherwise falls back to the expandable text view.
// Used for every tool's result, including rag_search.
function _renderToolResult(result) {
  const text = result || '';
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = undefined; }

  if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
    const treeWrap = document.createElement('div');
    treeWrap.className = 'tool-result-jsontree';
    treeWrap.style.cssText = 'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:0.92em;white-space:pre-wrap;';
    treeWrap.appendChild(_renderJsonValue(parsed, 0));
    return treeWrap;
  }
  return _renderToolResultText(text);
}


function _appendToolSummary(bubble, callsAndResults) {
  const wrap = bubble.parentElement;
  if (!wrap) return;
  wrap.querySelector('.tool-calls-summary')?.remove();

  const summary = document.createElement('div');
  summary.className = 'tool-calls-summary';
  summary.style.cssText =
    'margin-top:6px;border:1px solid var(--border);border-radius:6px;overflow:hidden;font-size:0.82em;';

  const header = document.createElement('div');
  header.style.cssText =
    'display:flex;align-items:center;gap:6px;padding:5px 9px;cursor:pointer;' +
    'background:var(--bg2);color:var(--text2);user-select:none;';
  header.innerHTML =
    `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
    ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77` +
    `a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91` +
    `a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>` +
    `<span>Tool calls (${callsAndResults.length})</span>` +
    `<svg class="tc-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none"` +
    ` stroke="currentColor" stroke-width="2.5" stroke-linecap="round">` +
    `<path d="M6 9l6 6 6-6"/></svg>`;

  const body = document.createElement('div');
  body.style.cssText = 'display:none;';

  header.addEventListener('click', () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    header.querySelector('.tc-chevron').style.transform = open ? '' : 'rotate(180deg)';
  });

  for (const { tc, result, error } of callsAndResults) {
    const row = document.createElement('div');
    row.style.cssText =
      'padding:6px 9px;border-top:1px solid var(--border);' +
      'background:var(--bg);word-break:break-word;';
    const argsStr = JSON.stringify(tc.function.arguments, null, 2);
    const resultColor = error ? 'var(--red)' : 'var(--green)';

    const nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-weight:600;color:var(--accent);margin-bottom:3px;';
    nameEl.textContent = `⚙ ${tc.function.name}`;
    row.appendChild(nameEl);

    const argsEl = document.createElement('pre');
    argsEl.style.cssText =
      'margin:0 0 4px;white-space:pre-wrap;font-size:0.9em;' +
      'color:var(--text2);background:var(--bg2);padding:4px 6px;border-radius:4px;';
    argsEl.textContent = argsStr;
    row.appendChild(argsEl);

    const resultWrap = document.createElement('div');
    resultWrap.style.cssText = `color:${resultColor};font-size:0.9em;`;
    resultWrap.appendChild(_renderToolResult(result));
    row.appendChild(resultWrap);

    body.appendChild(row);
  }

  summary.appendChild(header);
  summary.appendChild(body);
  wrap.insertBefore(summary, wrap.querySelector('.msg-stats-bar') || null);
}

// ── Send / receive ────────────────────────────────────────────
async function sendChat() {
  const rawText = chatInput.value.trim();

  // ── STANDARD PATH (TEXT / IMAGES / WEB SEARCH) ────────────
  const hasAttachments = chatAttachments.length > 0;
  if (!rawText && !hasAttachments) return;
  if (chatBusy) return;

  // Wait for any in-flight attachment processing (PDF rendering, MarkItDown
  // conversion) to finish before snapshotting.  Without this, rapidly
  // hitting Send while a large PDF is still rendering would capture
  // half-populated attachment objects.
  if (_attachProcessing > 0) {
    await new Promise(resolve => {
      const check = () => {
        if (_attachProcessing <= 0) return resolve();
        setTimeout(check, 50);
      };
      check();
    });
  }

  await ensureModelLoaded();

  // Snapshot all attachments then clear the UI immediately
  const attachedItems  = chatAttachments.slice();
  clearChatAttachment();

  // Build per-attachment display info for the bubble
  const attachmentInfoList = attachedItems.map(att => ({
    type:       att.type,
    name:       att.file?.name || '',
    size:       att.file?.size ?? null,
    objectUrl:  (att.type === 'image' && att.file) ? URL.createObjectURL(att.file) : null,
    // A second, independent blob URL for the lightbox created from the same file.
    // iOS Safari matches decoded bitmaps by content across URL schemes — if the
    // thumbnail blob URL was decoded at chip size, the same pixel content decoded
    // via dataUri or the same blob URL returns the cached low-res bitmap.
    // A freshly created blob URL is a new string with no cache entry, so iOS
    // decodes it at full resolution when the lightbox opens it.
    // Falls back to null on the restored-from-DB path (file is gone; objectUrl
    // is already a data-URI there and is used as chatLbSrc fallback below).
    lbUrl:      (att.type === 'image' && att.file) ? URL.createObjectURL(att.file) : null,
    dataUri:    (att.type === 'image' && att.b64)
                  ? (() => {
                      let mime = 'image/jpeg';
                      if (att.b64.startsWith('iVBOR'))     mime = 'image/png';
                      else if (att.b64.startsWith('R0lG')) mime = 'image/gif';
                      else if (att.b64.startsWith('UklG')) mime = 'image/webp';
                      return `data:${mime};base64,${att.b64}`;
                    })()
                  : null,
    // PDF: carry rendered page thumbnails so the bubble can show them as image chips.
    // hasText=true means the PDF has an extractable text layer → fileblocks.js will
    // render a <jarvis_file> card for it, so we must NOT also show page thumbnails
    // (that would double-display the PDF).  hasText=false (image-only / scanned PDF)
    // has no file card, so thumbnails are its only visual representation.
    // visualOverride mirrors the user's manual toggle so addBubble can derive the
    // *effective* send mode (image vs text) independently of hasText.
    pageImages:     att.type === 'pdf' ? (att.pageImages || []) : undefined,
    pageCount:      att.type === 'pdf' ? (att.pageCount  || 0) : undefined,
    hasText:        att.type === 'pdf' ? Boolean(att.text) : undefined,
    // scorerIsVisual = true when the page-scorer decided to send this PDF as images
    // (visualPages.length > 0).  This is the correct signal for "show thumbnail chip"
    // and "suppress fileblock" — NOT hasText, which only says whether text exists,
    // not whether the scorer preferred the visual path.  A PDF with sparse labels
    // (e.g. a CAD drawing) can have hasText=true AND scorerIsVisual=true; the chip
    // vs fileblock decision must follow the scorer, not the text presence alone.
    scorerIsVisual: att.type === 'pdf' ? (att.visualPages?.length > 0) : undefined,
    visualOverride: att.type === 'pdf' ? (att.visualOverride ?? null) : undefined,
    // Line count for text-only PDF fallback chip label
    lineCount:  att.type === 'pdf' && att.text
                  ? att.text.split('\n').filter(l => l.trim()).length
                  : undefined,
  }));

  function applyAttachment(msg) {
    // Images → Ollama images array (api.js converts to multipart for
    // LM Studio / OpenAI via _convertMessages).
    const imageItems = attachedItems.filter(a => a.type === 'image' && a.b64);
    const images = imageItems.map(a => a.b64);
    if (images.length) {
      msg.images = images;
      // Persist filename + byte-size alongside the b64 data so chips can be
      // reconstructed with full detail after a reload or JSON import.
      msg._attachImagesMeta = imageItems.map(a => ({
        name: a.file?.name || '',
        size: a.file?.size ?? null,
      }));
    }

    // Plain text files → inject as <jarvis_file> context blocks.
    const textFiles = attachedItems.filter(a => a.type === 'text' && a.text);
    if (textFiles.length) {
      const blocks = textFiles.map(a => {
        const name = a.file?.name || 'file';
        return (
          `[Attached file: ${name}]\n` + 
          `<jarvis_file name="${name}">\n${a.text}\n</` + `jarvis_file>`
        );
      }).join('\n');
      msg.content = blocks + '\n' + msg.content;
    }

    // PDF files — per-page visual scoring strategy:
    //
    //   Each page was scored during processing (visualScore ∈ [0,1]) using four
    //   signals: graphics operator count, text sparsity, short-token ratio, and
    //   embedded raster images.  Pages above the threshold (0.40) are "visually
    //   significant" — their meaning depends on spatial layout, not just text.
    //
    //   Decision per page:
    //     visualScore <  0.40  →  text extracted → model reads prose/table as text
    //     visualScore >= 0.40  →  PNG sent to vision model (+ text still extracted
    //                             so the model gets exact label values too)
    //
    //   Net result by document type:
    //     Plain document   → text block only, no images
    //     Scanned PDF      → images only, no text block (nothing to extract)
    //     CAD / schematic  → images + text block (labels as exact values)
    //     Mixed report     → images for chart pages, text for prose pages
    const pdfFiles = attachedItems.filter(a => a.type === 'pdf');
    if (pdfFiles.length) {
      // Always inject extracted text when present, UNLESS the user has forced
      // this PDF into image-only mode (visualOverride === true).
      // When force-image is active the text layer is suppressed so the model
      // isn't given both a full text dump AND the images for the same document,
      // which would be redundant and confusing for a document the user explicitly
      // wants processed visually.
      // (visualOverride === false means force-text: always inject text regardless.)
      const textBlocks = pdfFiles
        .filter(a => a.text && a.visualOverride !== true)
        .map(a => {
          const name  = a.file?.name || 'document.pdf';
          const pages = a.pageCount  || '?';
          const lines = a.text ? a.text.split('\n').filter(l => l.trim()).length : 0;
          const meta  = lines ? `${pages} page(s), ${lines} lines` : `${pages} page(s)`;
          return (
            `[Attached PDF: ${name} — ${meta}]\n` +
            `<jarvis_file name="${name}">\n${a.text}\n</` + `jarvis_file>`
          );
        })
        .join('\n');
      if (textBlocks) msg.content = textBlocks + '\n' + msg.content;

      // _pdfPages sidecar stores ALL page PNGs so IndexedDB / reload can
      // reconstruct thumbnails and vision context faithfully after a page refresh.
      const allPdfPageImages = pdfFiles.flatMap(a => a.pageImages || []);
      if (allPdfPageImages.length) {
        msg._pdfPages = allPdfPageImages;
        msg._pdfMeta  = pdfFiles.map(a => ({
          name:      a.file?.name || 'document.pdf',
          pageCount: a.pageCount  || 0,
          hasText:   Boolean(a.text),
        }));
      }

      // Send visually significant pages to the model as images.
      // Respects att.visualOverride set by the user toggle on the chip:
      //   null / undefined  → use scorer's visualPages (pages above threshold)
      //   true              → send ALL pages as images (force image mode)
      //   false             → send no pages as images (force text-only)
      const caps = (typeof modelCaps !== 'undefined' && modelCaps instanceof Map)
        ? (modelCaps.get(modelSel?.value) || new Set())
        : new Set();
      if (caps.has('vision')) {
        const visionPages = pdfFiles.flatMap(a => {
          if (a.visualOverride === true)  return a.pageImages || []; // force all pages
          if (a.visualOverride === false) return [];                  // force text-only
          return a.visualPages || [];                                 // scorer default
        });
        if (visionPages.length) {
          msg.images = [...(msg.images || []), ...visionPages];
        }
      }
    }

    return msg;
  }

  const userMsg = applyAttachment({ role: 'user', content: rawText });
  chatHistory.push(userMsg);
  shouldAutoScroll = true;
  // Use the full content (including <jarvis_file> blocks) as the bubble display
  // text so fileblocks.js renders them as file cards in the user bubble too.
  const userBubbleText = userMsg.content !== rawText ? userMsg.content : rawText;
  addBubble('user', userBubbleText, false, null, attachmentInfoList.length ? attachmentInfoList : null);
  chatInput.value = '';
  chatInput.style.height = 'auto';

  // Persist the user turn immediately so a tab-close mid-generation
  // still shows the question on next load (the answer arrives via reconnect).
  saveChatHistory();

  chatBusy = true;
  chatSendBtn.classList.add('hidden');
  chatStopBtn.classList.remove('hidden');

  currentAbortController = new AbortController();

  let reply = '';
  let thinkText = '';
  const bubble = addBubble('assistant', '', true);

  // ── BACKEND PATH ──────────────────────────────────────────────
  // When the backend server is available AND the user has not disabled backend
  // chat processing, hand off the entire turn to the server.
  // The server handles tool calling (HTTP tools) natively, including multi-round
  // tool loops.  MCP tools are browser-local and cannot run server-side; the
  // server returns a clear error message for those so the model is informed.
  // Toggle USE_BACKEND_CHAT off via the model-bar button to force local inference.
  if (typeof BACKEND_AVAILABLE !== 'undefined' && BACKEND_AVAILABLE &&
      typeof USE_BACKEND_CHAT !== 'undefined' && USE_BACKEND_CHAT &&
      typeof generateChatBackend === 'function') {

    const tools       = (typeof ToolsEngine !== 'undefined') ? ToolsEngine.buildSchemas() : [];
    const toolsCfg    = (typeof TOOLS_CONFIG !== 'undefined') ? TOOLS_CONFIG : [];
    const apiConfig   = { flavor: API_FLAVOR, base: OLLAMA_BASE };
    const _activeSys  = getActiveChatSystem();
    let messages      = _stripSidecars(_activeSys
      ? [{ role: 'system', content: _activeSys }, ...chatHistory]
      : [...chatHistory]);

    // Merge the current think-toggle state into options so the backend
    // respects it — RUNTIME_OPTIONS itself never carries a 'think' key.
    const backendOptions = {
      ...RUNTIME_OPTIONS,
      think: (typeof thinkToggle !== 'undefined') ? thinkToggle.checked : false,
    };

    // ── RAG: inject context into messages before sending to backend ─────────
    // injectRagContext() is defined in rag.js. It embeds the last user message,
    // retrieves top-k chunks from Qdrant, and prepends them to the system message.
    // We inject here (client-side) so backend.js doesn't need to change, and the
    // server-side rag_collection field is left empty (no double-retrieval).
    if (typeof injectRagContext === 'function') {
      const _lastUser = (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.role === 'user') {
            return typeof m.content === 'string' ? m.content
              : (Array.isArray(m.content)
                 ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
                 : '');
          }
        }
        return '';
      })();
      const { messages: _ragMsgs, chunks: _ragChunks } =
        await injectRagContext(messages, _lastUser);
      messages = _ragMsgs;
      if (_ragChunks.length) {
        const _ragSel = document.getElementById('rag-collection-select');
        renderRagContextCard(
          _ragSel ? (_ragSel.value || '') : '',
          _ragChunks,
          CHAT_ID || String(Date.now()),
        );
      }

      // ── Memory: inject long-term memory context, same trick as RAG above ──
      // injectMemoryContext() is defined in memory.js. Always client-side, on
      // both chat paths, so the server never needs to re-retrieve (avoids
      // double-injection) — see memory.js's file header for the full rationale.
      if (typeof injectMemoryContext === 'function') {
        const { messages: _memMsgs, chunks: _memChunks } =
          await injectMemoryContext(messages, _lastUser);
        messages = _memMsgs;
        if (_memChunks.length) {
          renderMemoryContextCard(_memChunks, CHAT_ID || String(Date.now()));
        }
      }
    }

    const jobId = await generateChatBackend(
      CHAT_ID, messages, modelSel.value, backendOptions, tools, toolsCfg, apiConfig,
      {
        ...((typeof getRagToolBackendPayload === 'function') ? getRagToolBackendPayload() : {}),
        ...((typeof getMemoryToolBackendPayload === 'function') ? getMemoryToolBackendPayload() : {}),
      }
    );

    if (jobId) {
      // Register this job so SSE callbacks route to the right bubble
      _backendJobId      = jobId;
      _backendBubble     = bubble;
      _backendToolBubble = null;
      _backendReply      = '';
      _backendImgIdsThisTurn = [];
      _chatBackendImgSubJobIds.clear();
      _backendThink      = '';
      _backendToolSums   = [];
      // This job uses the global SSE stream (not per-job), so don't add to the set
      _backendJobStreamActive.delete(jobId);
      // chatBusy remains true; cleared by _chatOnBackendDone / Error
      showToast?.(`Chat sent to server.`, 2000);
      return;
    }

    // If submission failed, fall through to local path and reset UI
    console.warn('[chat] generateChatBackend returned null — falling back to local');
  }

  // ── LOCAL PATH ────────────────────────────────────────────────
  try {
    // ── Build tools schema (safe no-op when ToolsEngine absent) ──
    const tools = (typeof ToolsEngine !== 'undefined') ? ToolsEngine.buildSchemas() : [];

    // ── Tool-call round-trip loop ─────────────────────────────────
    // Each iteration sends a request; if the model returns tool_calls
    // we execute them, append results to history, and loop.
    // We cap iterations to prevent runaway loops. Configurable in
    // Settings → Tool Calling (global MAX_TOOL_ROUNDS from config.js);
    // 0 means unlimited.
    const _maxToolRounds = (typeof MAX_TOOL_ROUNDS === 'number' && MAX_TOOL_ROUNDS >= 0) ? MAX_TOOL_ROUNDS : 5;
    let   toolRound       = 0;
    let   activeBubble    = bubble;  // bubble to stream final text into

    // Accumulates every tool call + result across ALL rounds so the UI
    // can show a single "Tool calls (N)" summary rather than one per round.
    const allCallsAndResults = [];
    // The bubble whose parentElement wrapper holds the unified summary.
    // Set on the first tool-call round; subsequent rounds update the same block.
    let toolSummaryBubble = null;

    // Last user message text — used as the RAG query on the first round
    const _ragUserQuery = (() => {
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        const m = chatHistory[i];
        if (m.role === 'user') {
          return typeof m.content === 'string' ? m.content
            : (Array.isArray(m.content)
               ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
               : '');
        }
      }
      return '';
    })();
    let _ragChunksRendered = false;
    let _memChunksRendered = false;

    while (true) {
      const _activeSys = getActiveChatSystem();
      let messages = _stripSidecars(_activeSys
        ? [{ role: 'system', content: _activeSys }, ...chatHistory]
        : [...chatHistory]);

      // ── RAG context injection (local/direct path, first round only) ──────
      if (toolRound === 0 && typeof injectRagContext === 'function') {
        const { messages: _ragMsgs, chunks: _ragChunks } =
          await injectRagContext(messages, _ragUserQuery);
        messages = _ragMsgs;
        if (_ragChunks.length && !_ragChunksRendered) {
          _ragChunksRendered = true;
          const _ragSel = document.getElementById('rag-collection-select');
          renderRagContextCard(
            _ragSel ? (_ragSel.value || '') : '',
            _ragChunks,
            CHAT_ID || String(Date.now()),
          );
        }
      }

      // ── Memory context injection (local/direct path, first round only) ───
      if (toolRound === 0 && typeof injectMemoryContext === 'function') {
        const { messages: _memMsgs, chunks: _memChunks } =
          await injectMemoryContext(messages, _ragUserQuery);
        messages = _memMsgs;
        if (_memChunks.length && !_memChunksRendered) {
          _memChunksRendered = true;
          renderMemoryContextCard(_memChunks, CHAT_ID || String(Date.now()));
        }
      }

      API.resetStream();
      const { url: _chatUrl, body: _chatBody, lmsNative: _lmsNative } =
        API.chatRequest(messages, lmsResponseId, tools);

      if (_lmsNative) {
        // ── LM STUDIO NATIVE PATH (/api/v1/chat, streaming) ────────
        // Tool calling goes through the OpenAI-compat path; native path
        // is used here unchanged (no tool injection).
        const res = await fetch(_chatUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          signal:  currentAbortController.signal,
          body:    JSON.stringify(_chatBody)
        });
        if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let lastStats = null;
        const t0 = performance.now();
        let ttftMs = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const chunk = LMStudioAPI.parseNativeChatChunk(line);
              if (chunk.thinking) {
                thinkText += chunk.thinking;
                updateThinkBubble(activeBubble, thinkText, true);
              }
              if (chunk.content) {
                if (ttftMs === null) ttftMs = performance.now() - t0;
                reply += chunk.content;
                updateBubble(activeBubble, reply, true);
              }
              if (chunk.responseId) lmsResponseId = chunk.responseId;
              if (chunk.stats)      lastStats = chunk.stats;
            } catch {}
          }
        }
        updateThinkBubble(activeBubble, thinkText, false);
        updateBubble(activeBubble, reply, false);
        renderStatsBar(activeBubble, LMStudioAPI.parseStats({ stats: lastStats }, null));
        break; // LMS native: no tool loop

      } else {
        // ── STREAMING PATH (Ollama / OpenAI-compat) ──────────────
        const res = await fetch(_chatUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          signal:  currentAbortController.signal,
          body:    JSON.stringify(_chatBody)
        });
        if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let lastRawChunk   = null;
        const t0           = performance.now();
        let ttftMs         = null;
        // Tool-call accumulators for this turn
        const oaiToolAcc   = {};   // OpenAI streaming deltas
        let   ollamaToolTC = null; // Ollama final done chunk

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const rawLine = line.startsWith('data: ') ? line.slice(6) : line;
              if (rawLine.trim() !== '[DONE]') {
                try { lastRawChunk = JSON.parse(rawLine); } catch {}
              }
              const chunk = API.parseChatChunk(line);
              if (chunk.thinking) {
                thinkText += chunk.thinking;
                updateThinkBubble(activeBubble, thinkText, true);
              }
              if (chunk.content) {
                if (ttftMs === null) ttftMs = performance.now() - t0;
                reply += chunk.content;
                updateBubble(activeBubble, reply, true);
              }
              // Accumulate tool call deltas
              if (chunk.toolCallsDelta)
                API.accumulateToolCallDelta(oaiToolAcc, chunk.toolCallsDelta);
              if (chunk.toolCalls)
                ollamaToolTC = chunk.toolCalls;
            } catch {}
          }
        }

        // ── Strip model tool-response artifacts from streamed text ─
        // Must happen before the tool-call check so the artifact is
        // never shown as a normal chat bubble, even transiently.
        reply = _stripToolArtifacts(reply);

        // ── Resolve tool calls for this turn ───────────────────
        const turnToolCalls = API.normalizeToolCalls(oaiToolAcc, ollamaToolTC);

        if (turnToolCalls.length && (_maxToolRounds === 0 || toolRound < _maxToolRounds) && tools.length) {
          // Model wants to call tools — show a brief indicator in the current bubble.
          // One shimmer placeholder per generate_image call in this round —
          // purely transient, this bubble's content gets reset to plain
          // `reply` once the round resolves (see updateBubble(toolSummaryBubble...)
          // below), so it naturally disappears in favor of the real image,
          // which renders in the next bubble via roundImageIds.
          const loadingTags = turnToolCalls
            .filter(tc => tc.function.name === 'generate_image')
            .map(() => `<jarvis_img_loading></jarvis_img_loading>`)
            .join('\n');
          updateBubble(activeBubble,
            (reply || '') + (reply ? '\n\n' : '') + loadingTags,
            true
          );
          if (loadingTags) _startChatImgProgress(activeBubble);

          // Append assistant's tool-call message to history
          chatHistory.push(API.buildAssistantToolMsg(turnToolCalls));

          // Execute each tool call and collect results
          const callsAndResults = [];
          const roundImageIds   = []; // <jarvis_img> ids generated this round, for the next bubble
          for (const tc of turnToolCalls) {
            let result = '', error = false, toolImageId = null; // scoped per-iteration — no carryover
            try {
              result = await ToolsEngine.executeToolCall(
                tc.function.name, tc.function.arguments
              );
              // ── generate_image marker detection ────────────────────
              // tools.js's built-in generate_image tool returns a
              // `[[JARVIS_IMAGE:id]]` marker prefix instead of raw base64,
              // so the (possibly multi-MB) image data never rides along in
              // the tool-result text sent back to the model. Strip it here,
              // leaving only a short human-readable confirmation for the
              // model, and remember the id so the tag can be rendered in
              // the chat bubble and persisted via a sidecar below.
              const imgMatch = /\[\[JARVIS_IMAGE:([A-Za-z0-9_]+)\]\]\s*/.exec(result);
              if (imgMatch) {
                toolImageId = imgMatch[1];
                result = result.slice(imgMatch[0].length).trim() || 'Image generated and shown to the user.';
                roundImageIds.push(toolImageId);
              }
            } catch (e) {
              result = `Error: ${e.message}`;
              error  = true;
            }
            const toolMsg = API.buildToolResultMsg(tc, result);
            if (toolImageId && _toolImageStore.has(toolImageId)) {
              // Persistence-only sidecar — stripped before every model request
              // via _stripSidecars()/_SIDECAR_KEYS, kept on save/restore.
              toolMsg._toolImages = { [toolImageId]: _toolImageStore.get(toolImageId) };
            }
            chatHistory.push(toolMsg);
            callsAndResults.push({ tc, result, error });
          }
          // Merge into the cross-round accumulator
          for (const car of callsAndResults) allCallsAndResults.push(car);
          _stopChatImgProgress();

          // ── Unified summary ──────────────────────────────────────
          // All rounds share ONE summary block on the first tool-call bubble.
          // Sequential rounds: the count increments and new rows appear.
          // Parallel calls in one round: all show up immediately.
          if (!toolSummaryBubble) {
            // First tool-call round — anchor the summary here.
            toolSummaryBubble = activeBubble;
            updateBubble(toolSummaryBubble, reply || '', false);
            if (!reply) {
              toolSummaryBubble.style.display = 'none';
              const copyBtn = toolSummaryBubble.parentElement
                ?.querySelector('.bubble-copy-btn');
              if (copyBtn) copyBtn.style.display = 'none';
            }
          } else {
            // Subsequent round — the intermediate bubble (activeBubble) carried
            // only the "⚙ Calling…" indicator and has no real content.
            // Remove its wrapper entirely to keep the DOM clean.
            if (!reply) activeBubble.parentElement?.remove();
          }
          // Update (or create) the summary with every result accumulated so far
          _appendToolSummary(toolSummaryBubble, allCallsAndResults);

          // Open a fresh bubble for the model's continuation. Any images
          // generated this round render immediately via their <jarvis_img>
          // tags — before the model's own follow-up text streams in below them.
          reply = roundImageIds.map(id => `<jarvis_img id="${id}"></jarvis_img>`).join('\n')
                + (roundImageIds.length ? '\n\n' : '');
          thinkText = '';
          activeBubble = addBubble('assistant', reply, true);
          toolRound++;
          // Loop: send updated history back to model
          continue;
        }

        // No tool calls (or cap reached) — finalise normally
        const timing = {
          totalSec: (performance.now() - t0) / 1000,
          ttftSec:  ttftMs !== null ? ttftMs / 1000 : null
        };
        updateThinkBubble(activeBubble, thinkText, false);
        updateBubble(activeBubble, reply, false);
        renderStatsBar(activeBubble, parseStats(lastRawChunk, timing));
        break;
      }
    } // end tool-call loop

    chatHistory.push({ role: 'assistant', content: reply });
  } catch (e) {
    if (e.name === 'AbortError') {
      reply += ' [Generation cancelled]';
      updateBubble(bubble, reply, false);
      chatHistory.push({ role: 'assistant', content: reply });
    } else {
      updateBubble(bubble, `Error: ${e.message}`, false);
      bubble.style.color = 'var(--red)';
      chatHistory.pop();
    }
  } finally {
    _stopChatImgProgress();
    chatBusy = false;
    chatSendBtn.classList.remove('hidden');
    chatStopBtn.classList.add('hidden');
    chatInput.focus();
    currentAbortController = null;
    saveChatHistory();
  }
}

function clearChat() {
  if (chatBusy) return;
  chatHistory    = [];
  lmsResponseId  = null;
  _stopChatImgProgress();
  _backendJobId      = null;
  _backendBubble     = null;
  _backendToolBubble = null;
  _backendReply      = '';
  _backendImgIdsThisTurn = [];
  _chatBackendImgSubJobIds.clear();
  _toolImagesByAssistantPos = new Map();
  _backendThink      = '';
  _backendToolSums   = [];
  while (chatMessagesEl.lastChild && chatMessagesEl.lastChild !== chatEmpty)
    chatMessagesEl.removeChild(chatMessagesEl.lastChild);
  chatEmpty.style.display = '';
  jumpBottomBtn.classList.add('hidden');
  shouldAutoScroll = true;
  clearChatAttachment();
  chatInput.value = '';
  chatInput.style.height = 'auto';
  _clearChatDB();
  // Remove the context bar from whichever message wrap it currently lives in
  _lastCtxUsed = null;
  updateCtxMonitor(null, null);
}

// ── Chat Export / Import ──────────────────────────────────────
function exportChat() {
  if (!chatHistory.length) return;
  const payload = {
    exportedAt: new Date().toISOString(),
    model:      modelSel?.value || '',
    // Run through the same sanitiser used for IndexedDB: strips runtime-only
    // msg.images (rebuilt on load from _pdfPages) so the export never contains
    // the same base64 data twice.
    messages:   _sanitizeHistory(chatHistory)
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const ts   = new Date().toISOString().slice(0, 19).replace(/[:T]/g, (c) => c === 'T' ? '_' : '-');
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${ts}_jarvis_chat.json`;
  a.click();
  URL.revokeObjectURL(url);
}

const _chatImportInput = document.createElement('input');
_chatImportInput.type   = 'file';
_chatImportInput.accept = '.json,application/json';
_chatImportInput.addEventListener('change', async () => {
  const file = _chatImportInput.files?.[0];
  if (!file) return;
  _chatImportInput.value = '';
  try {
    const text    = await file.text();
    const payload = JSON.parse(text);
    const msgs    = Array.isArray(payload) ? payload : payload?.messages;
    if (!Array.isArray(msgs) || !msgs.length) throw new Error('No messages found in file.');

    // Confirm if there's an active conversation
    if (chatHistory.length) {
      if (!confirm('Loading this file will replace the current conversation. Continue?')) return;
    }

    clearChat();
    chatHistory = msgs;
    let _importAssistantIdx = -1;
    for (const msg of chatHistory) {
      if (msg.role === 'assistant') _importAssistantIdx++;
      if (msg._toolImages) {
        const ids = Object.keys(msg._toolImages);
        for (const [id, imgData] of Object.entries(msg._toolImages)) _toolImageStore.set(id, imgData);
        if (ids.length) _toolImagesByAssistantPos.set(_importAssistantIdx, ids);
      }
      // _restoreMsgAttachments mutates msg (restores msg.images from _pdfPages)
      // and returns the attachmentInfo array for addBubble.
      const attachmentInfo = _restoreMsgAttachments(msg);
      const text = Array.isArray(msg.content)
        ? (msg.content.find(p => p.type === 'text')?.text || '')
        : (msg.content || '');
      addBubble(msg.role, text, false, null, attachmentInfo);
    }
    chatEmpty.style.display = 'none';
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    saveChatHistory();
  } catch (e) {
    alert(`Import failed: ${e.message}`);
  }
});

function importChat() { _chatImportInput.click(); }


// ── Event listeners ───────────────────────────────────────────
chatSendBtn.addEventListener('click', sendChat);
chatStopBtn.addEventListener('click', () => {
  // Cancel local streaming
  currentAbortController?.abort();
  // Cancel backend job if one is running
  if (_backendJobId) {
    fetch(`/api/jobs/${_backendJobId}/cancel`, {
      method: 'POST',
      headers: { 'X-Client-ID': CLIENT_ID }
    }).catch(() => {});
  }
});
chatClearBtn.addEventListener('click', clearChat);
document.getElementById('chat-export-btn')?.addEventListener('click', exportChat);
document.getElementById('chat-import-btn')?.addEventListener('click', importChat);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (isMobile()) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); sendChat(); return; }
  }
  // Ctrl/Cmd+Shift+Space → send; Ctrl/Cmd+Shift+D → clear.
  // Registered here (element level) so they fire before the browser or OS
  // can intercept these combos — the same reason Ctrl+Enter is wired here
  // rather than on the document.
  if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
    if (e.code === 'Space') { e.preventDefault(); sendChat();  return; }
    if (e.code === 'KeyD')  { e.preventDefault(); clearChat(); return; }
  }
});
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 260) + 'px';
});

// ── Initial focus (desktop only) ──────────────────────────────
// Called here rather than from main.js because chatInput is local to
// this file and doesn't exist when main.js's init IIFE runs.
if (!isMobile() && currentMode === 'chat') chatInput.focus();
