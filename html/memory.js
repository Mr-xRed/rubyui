// ══ MEMORY.JS ═══════════════════════════════════════════════════
// Long-term memory — client side. One global memory store for the whole
// user (not per-chat, not per-collection): a single server-side Qdrant
// collection ("jarvis_memory") backed by human-readable markdown files.
//
// Mirrors rag.js's "always" mode almost exactly:
//   - injectMemoryContext()  ~ injectRagContext()   (client-side retrieval,
//     works for BOTH the local/direct path and the backend-offloaded path —
//     called from chat.js right before the request is sent, so there is
//     never a double-retrieval: the server never re-injects memory itself.)
//   - renderMemoryContextCard() ~ renderRagContextCard() (reuses the same
//     .rag-ctx-* CSS classes so no styles.css edit is needed)
//   - a small self-contained EventSource ~ rag.js's _hookRagSseEvent(),
//     used ONLY to catch the 'memory-saved' event emitted when the model
//     calls save_memory on the backend-offloaded path (that write happens
//     server-side, so the browser has no other way to know about it).
//
// Depends on: config.js (MEMORY_ENABLED, MEMORY_TOP_K, RAG_QDRANT_URL,
// RAG_EMBED_MODEL, RAG_EMBED_FLAVOR, OLLAMA_BASE — memory reuses the RAG
// embedding pipeline rather than introducing a second one).
//
// Load order in index.html: insert directly after rag.js.
//   ... → tools.js → settings.js → corrector.js → fileblocks.js
//   → backend.js → rag.js → memory.js (THIS FILE)  ← insert here
//   → status-panel.js

function _esc_mem(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/**
 * The same Client ID used everywhere else to route backend jobs/SSE to the
 * right browser. IMPORTANT: this must prioritize BACKEND_CLIENT_ID_OVERRIDE
 * (config.js/settings.js's "Client ID override" field) over the raw
 * auto-generated CLIENT_ID global — that override is the whole point of the
 * setting, and the backend job/SSE path already treats it as authoritative.
 * Reading bare CLIENT_ID here (an earlier bug) caused memory to be written
 * under the auto-generated default ID while chat jobs used the override,
 * silently splitting one user's memories across two folders/collections.
 * memory.py's _client_id_from_request() reads whatever we send here.
 */
function getEffectiveClientId() {
  if (typeof BACKEND_CLIENT_ID_OVERRIDE !== 'undefined' && BACKEND_CLIENT_ID_OVERRIDE) return BACKEND_CLIENT_ID_OVERRIDE;
  if (typeof CLIENT_ID !== 'undefined' && CLIENT_ID) return CLIENT_ID;
  return localStorage.getItem('_jarvis_client_id') || 'anonymous';
}
window.getEffectiveClientId = getEffectiveClientId;

function _memoryHeaders(extra) {
  return { 'X-Client-ID': getEffectiveClientId(), ...(extra || {}) };
}

// ── Direct (no-backend) memory search ───────────────────────────────────
// Mirrors memory.py's memory_search_chunks(): same collection-naming
// scheme (jarvis_memory_<sanitized client id>), same Qdrant Query API call,
// same "no collection yet → []" tolerance. Reuses rag.js's _embedDirect()
// for the embedding call rather than duplicating it — rag.js loads
// immediately before this file (see load-order note at the top), so
// _embedDirect is already a global by the time this runs.
//
// Retrieval only: saving/updating/deleting memories still requires the
// backend, since memory.py writes the markdown source-of-truth files
// server-side — the browser has no filesystem access to do that itself.
function _sanitizeClientIdDirect(clientId) {
  const slug = String(clientId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return slug || 'anonymous';
}

function _memoryCollectionNameDirect(clientId) {
  return `jarvis_memory_${_sanitizeClientIdDirect(clientId)}`;
}

async function _memorySearchDirect(query, topK, scoreThreshold, embedModel, embedFlavor, ollamaBase, qdrantUrl) {
  if (typeof _embedDirect !== 'function') return []; // rag.js didn't load / load order broken
  const base = (qdrantUrl || '').replace(/\/$/, '');
  const collection = _memoryCollectionNameDirect(getEffectiveClientId());

  // Same tolerance as memory.py: a client with nothing saved yet has no
  // collection at all — that's not an error, just an empty result.
  try {
    const infoResp = await fetch(`${base}/collections/${encodeURIComponent(collection)}`);
    if (!infoResp.ok) return [];
  } catch (_) { return []; }

  try {
    const vecs = await _embedDirect([query], embedModel, ollamaBase, embedFlavor);
    const resp = await fetch(`${base}/collections/${encodeURIComponent(collection)}/points/query`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: vecs[0],
        limit: topK,
        with_payload: true,
        score_threshold: (scoreThreshold && scoreThreshold > 0) ? scoreThreshold : null,
      }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const points = (data.result && data.result.points) || [];
    return points.map(p => ({ id: String(p.id), score: Math.round((p.score || 0) * 1e4) / 1e4, ...(p.payload || {}) }));
  } catch (_) {
    return [];
  }
}

/**
 * crypto.randomUUID() requires a secure context (https, or localhost) —
 * this app is frequently accessed over plain HTTP on a LAN IP, which is
 * NOT a secure context, so that API silently doesn't exist there. Fallback
 * to a plain RFC4122-ish v4 generator so direct-mode save/update never
 * hard-fails just because of how the page happens to be served.
 */
function _uuidv4() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID(); } catch (_) {}
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Create this client's Qdrant collection on first use if it doesn't exist
 * yet — mirrors memory.py's _ensure_memory_collection(). A create-after-
 * exists race just gets swallowed (Qdrant already has it), same tolerance
 * as the server-side version.
 */
async function _ensureMemoryCollectionDirect(qdrantUrl, collection, dim) {
  const base = (qdrantUrl || '').replace(/\/$/, '');
  try {
    const resp = await fetch(`${base}/collections/${encodeURIComponent(collection)}`);
    if (resp.ok) return;
  } catch (_) {}
  try {
    await fetch(`${base}/collections/${encodeURIComponent(collection)}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ vectors: { size: dim, distance: 'Cosine' } }),
    });
  } catch (_) {}
}

/** Upsert one point directly into Qdrant — mirrors memory.py's _upsert_point(). */
async function _upsertMemoryPointDirect(qdrantUrl, collection, id, vector, payload) {
  const base = (qdrantUrl || '').replace(/\/$/, '');
  const resp = await fetch(`${base}/collections/${encodeURIComponent(collection)}/points?wait=true`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ points: [{ id, vector, payload }] }),
  });
  if (!resp.ok) throw new Error(`Qdrant upsert HTTP ${resp.status}`);
}

/** Fetch one point's current payload by id, for partial updates. Returns null if missing. */
async function _retrieveMemoryPointDirect(qdrantUrl, collection, id) {
  const base = (qdrantUrl || '').replace(/\/$/, '');
  try {
    const resp = await fetch(`${base}/collections/${encodeURIComponent(collection)}/points`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ids: [id], with_payload: true, with_vector: false }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data.result || [])[0] || null;
  } catch (_) {
    return null;
  }
}

// ── Tool executors: save_memory / search_memory / update_memory ────────
// Called by tools.js's BUILTIN_CATALOGUE entries — same delegation pattern
// rag.js already uses for the rag_search tool (see executeRagSearchTool /
// getRagToolSchema there, and tools.js's window.executeRagSearchTool call).
// Each of these branches internally on BACKEND_AVAILABLE:
//
//   BACKEND AVAILABLE  → unchanged. Goes through /api/memory/*, which
//     writes the markdown file (source of truth) AND the Qdrant index,
//     exactly as before this change.
//
//   DIRECT / NO BACKEND → new. Writes ONLY into Qdrant — there is no
//     filesystem the browser can write markdown to. This means Qdrant is,
//     for entries saved in this mode, the *only* copy, not the disposable
//     rebuildable index memory.py normally treats it as. Practical
//     consequences: these entries won't appear in Settings → Memory browse
//     /edit (that reads markdown files) and won't survive a "reindex all"
//     later, since there's no markdown to reindex from. Search/recall
//     works fine either way, since that only ever reads Qdrant.

async function executeSaveMemoryTool({ text, tags, confidence }) {
  if (!text || !text.trim()) throw new Error('text must not be empty.');
  const cleanText       = text.trim().slice(0, 4000);
  const cleanTags       = Array.isArray(tags) ? tags.slice(0, 10).map(String) : [];
  const cleanConfidence = (confidence === 'inferred') ? 'inferred' : 'stated';

  if (typeof BACKEND_AVAILABLE === 'undefined' || !BACKEND_AVAILABLE) {
    const now        = new Date().toISOString();
    const id          = _uuidv4();
    const collection  = _memoryCollectionNameDirect(getEffectiveClientId());
    try {
      const vecs = await _embedDirect([cleanText], RAG_EMBED_MODEL, OLLAMA_BASE, RAG_EMBED_FLAVOR);
      await _ensureMemoryCollectionDirect(RAG_QDRANT_URL, collection, vecs[0].length);
      await _upsertMemoryPointDirect(RAG_QDRANT_URL, collection, id, vecs[0], {
        text:       cleanText,
        tags:       cleanTags,
        source:     (typeof CHAT_ID !== 'undefined' && CHAT_ID) || 'chat',
        confidence: cleanConfidence,
        created:    now,
        updated:    now,
      });
    } catch (e) {
      return JSON.stringify({ saved: true, id, indexed: false, error: e.message });
    }
    if (typeof showToast === 'function') {
      showToast(`Saved to memory: "${cleanText.slice(0, 60)}${cleanText.length > 60 ? '…' : ''}"`, 2500);
    }
    return JSON.stringify({ saved: true, id, indexed: true });
  }

  const resp = await fetch('/api/memory/save', {
    method:  'POST',
    headers: _memoryHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      text:         cleanText,
      tags:         cleanTags,
      confidence:   cleanConfidence,
      source:       (typeof CHAT_ID !== 'undefined' && CHAT_ID) || 'chat',
      embed_model:  RAG_EMBED_MODEL,
      embed_flavor: RAG_EMBED_FLAVOR,
      ollama_base:  OLLAMA_BASE,
      qdrant_url:   RAG_QDRANT_URL,
    }),
  });
  if (!resp.ok) throw new Error(`Failed to save memory: HTTP ${resp.status}`);
  const data = await resp.json();
  if (typeof showToast === 'function') {
    showToast(`Saved to memory: "${cleanText.slice(0, 60)}${cleanText.length > 60 ? '…' : ''}"`, 2500);
  }
  return JSON.stringify({ saved: true, id: data.id, indexed: !!data.indexed });
}

async function executeSearchMemoryTool({ query, top_k }) {
  if (!query || !query.trim()) throw new Error('query must not be empty.');
  let topK = parseInt(top_k, 10);
  if (!Number.isFinite(topK)) topK = 5;
  topK = Math.max(1, Math.min(20, topK));
  const cleanQuery     = query.trim().slice(0, 2000);
  const scoreThreshold = (typeof MEMORY_MIN_SCORE === 'number') ? MEMORY_MIN_SCORE : 0.55;

  let results;
  if (typeof BACKEND_AVAILABLE === 'undefined' || !BACKEND_AVAILABLE) {
    results = await _memorySearchDirect(
      cleanQuery, topK, scoreThreshold, RAG_EMBED_MODEL, RAG_EMBED_FLAVOR, OLLAMA_BASE, RAG_QDRANT_URL,
    );
  } else {
    const resp = await fetch('/api/memory/search', {
      method:  'POST',
      headers: _memoryHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        query: cleanQuery, top_k: topK, score_threshold: scoreThreshold,
        embed_model: RAG_EMBED_MODEL, embed_flavor: RAG_EMBED_FLAVOR,
        ollama_base: OLLAMA_BASE, qdrant_url: RAG_QDRANT_URL,
      }),
    });
    if (!resp.ok) throw new Error(`Memory search failed: HTTP ${resp.status}`);
    const data = await resp.json();
    results = data.results || [];
  }
  return JSON.stringify({ query: cleanQuery, top_k: topK, results });
}

async function executeUpdateMemoryTool({ id, text, tags, confidence }) {
  if (!id || !String(id).trim()) throw new Error('id is required — call search_memory first to find it.');
  const cleanId = String(id).trim();

  if (typeof BACKEND_AVAILABLE === 'undefined' || !BACKEND_AVAILABLE) {
    const collection = _memoryCollectionNameDirect(getEffectiveClientId());
    const existing = await _retrieveMemoryPointDirect(RAG_QDRANT_URL, collection, cleanId);
    if (!existing) {
      throw new Error(`No memory found with id "${cleanId}". Use search_memory to find the correct id, or save_memory if this is actually new information.`);
    }
    const p = existing.payload || {};
    const newText       = (typeof text === 'string' && text.trim()) ? text.trim().slice(0, 4000) : (p.text || '');
    const newTags       = Array.isArray(tags) ? tags.slice(0, 10).map(String) : (p.tags || []);
    const newConfidence = (confidence === 'stated' || confidence === 'inferred') ? confidence : (p.confidence || 'stated');
    const now = new Date().toISOString();
    try {
      const vecs = await _embedDirect([newText], RAG_EMBED_MODEL, OLLAMA_BASE, RAG_EMBED_FLAVOR);
      await _upsertMemoryPointDirect(RAG_QDRANT_URL, collection, cleanId, vecs[0], {
        text: newText, tags: newTags, source: p.source || 'chat',
        confidence: newConfidence, created: p.created || now, updated: now,
      });
    } catch (e) {
      return JSON.stringify({ updated: true, id: cleanId, indexed: false, error: e.message });
    }
    if (typeof showToast === 'function') {
      showToast(`Memory updated${newText ? `: "${newText.slice(0, 60)}${newText.length > 60 ? '…' : ''}"` : ''}`, 2500);
    }
    return JSON.stringify({ updated: true, id: cleanId, indexed: true });
  }

  const body = {
    embed_model: RAG_EMBED_MODEL, embed_flavor: RAG_EMBED_FLAVOR,
    ollama_base: OLLAMA_BASE, qdrant_url: RAG_QDRANT_URL,
  };
  if (typeof text === 'string' && text.trim()) body.text = text.trim().slice(0, 4000);
  if (Array.isArray(tags)) body.tags = tags.slice(0, 10).map(String);
  if (confidence === 'stated' || confidence === 'inferred') body.confidence = confidence;

  const resp = await fetch(`/api/memory/${encodeURIComponent(cleanId)}`, {
    method:  'PUT',
    headers: _memoryHeaders({ 'Content-Type': 'application/json' }),
    body:    JSON.stringify(body),
  });
  if (resp.status === 404) {
    throw new Error(`No memory found with id "${cleanId}". Use search_memory to find the correct id, or save_memory if this is actually new information.`);
  }
  if (!resp.ok) throw new Error(`Failed to update memory: HTTP ${resp.status}`);
  const data = await resp.json();
  if (typeof showToast === 'function') {
    showToast(`Memory updated${text ? `: "${text.trim().slice(0, 60)}${text.trim().length > 60 ? '…' : ''}"` : ''}`, 2500);
  }
  return JSON.stringify({ updated: true, id: data.id, indexed: !!data.indexed });
}

window.executeSaveMemoryTool   = executeSaveMemoryTool;
window.executeSearchMemoryTool = executeSearchMemoryTool;
window.executeUpdateMemoryTool = executeUpdateMemoryTool;

/**
 * Client-side memory retrieval + injection, used on BOTH chat paths.
 * Embeds the latest user turn, retrieves top-k memories from the server's
 * single global memory collection, and prepends them to the system
 * message — same shape as rag.js's injectRagContext(), just no collection
 * picker (there's only ever one memory store).
 *
 * @param {Array}  messages  - the messages array about to be sent
 * @param {string} userQuery - the latest user turn text (for embedding)
 * @returns {Promise<{messages: Array, chunks: Array}>}
 */
async function injectMemoryContext(messages, userQuery) {
  if (typeof MEMORY_ENABLED !== 'undefined' && !MEMORY_ENABLED) return { messages, chunks: [] };
  if (!userQuery) return { messages, chunks: [] };

  const topK           = (typeof MEMORY_TOP_K === 'number' && MEMORY_TOP_K) || 5;
  const scoreThreshold  = (typeof MEMORY_MIN_SCORE === 'number') ? MEMORY_MIN_SCORE : 0.55;

  let chunks = [];
  if (typeof BACKEND_AVAILABLE === 'undefined' || !BACKEND_AVAILABLE) {
    // Direct path: no server.py to hit /api/memory/search on, so search
    // Qdrant (via Ollama embeddings) straight from the browser.
    chunks = await _memorySearchDirect(
      userQuery.slice(0, 2000), topK, scoreThreshold,
      RAG_EMBED_MODEL, RAG_EMBED_FLAVOR, OLLAMA_BASE, RAG_QDRANT_URL,
    );
  } else {
    try {
      const resp = await fetch('/api/memory/search', {
        method:  'POST',
        headers: _memoryHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          query:        userQuery.slice(0, 2000),
          top_k:        topK,
          score_threshold: scoreThreshold,
          embed_model:  RAG_EMBED_MODEL,
          embed_flavor: RAG_EMBED_FLAVOR,
          ollama_base:  OLLAMA_BASE,
          qdrant_url:   RAG_QDRANT_URL,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        chunks = data.results || [];
      }
    } catch (_) {}
  }

  if (!chunks.length) return { messages, chunks: [] };

  const ctxBlock = _buildMemoryContextBlock(chunks);
  const msgs = [...messages];

  if (msgs.length && msgs[0].role === 'system') {
    msgs[0] = { ...msgs[0], content: (msgs[0].content || '') + ctxBlock };
  } else {
    msgs.unshift({ role: 'system', content: ctxBlock.trim() });
  }
  return { messages: msgs, chunks };
}

/** Build the markdown context block injected into the system prompt. */
function _buildMemoryContextBlock(chunks) {
  let block = '\n\n---\n## Long-term memory\n';
  block += 'The following were previously saved to long-term memory and may be relevant to this conversation. ' +
           'Treat them as background context about the user, not as something they just said.\n\n';
  chunks.forEach((c) => {
    const tags = Array.isArray(c.tags) && c.tags.length ? ` [${c.tags.join(', ')}]` : '';
    block += `- ${c.text || ''}${tags}\n`;
  });
  block += '---';
  return block;
}

/**
 * Render a memory context card into the chat message list. Reuses the
 * .rag-ctx-* CSS classes (already defined in styles.css for RAG's context
 * card) plus a modifier class, so no CSS file changes are needed.
 */
function renderMemoryContextCard(chunks, chatId) {
  if (!chunks || !chunks.length) return;

  const msgList = document.getElementById('chat-messages') || document.getElementById('messages-list');
  if (!msgList) return;

  const turnIdx = msgList.querySelectorAll('.memory-ctx-card').length;
  const cardId  = `memory-ctx-${chatId || 'c'}-${turnIdx}`;
  if (document.getElementById(cardId)) return;

  const card = document.createElement('div');
  card.id = cardId;
  // NOTE: the outer wrapper must be "rag-context-card" — that's the class
  // styles.css actually defines width/collapse-expand rules for. The inner
  // rag-ctx-header/rag-ctx-body/etc. classes are correct as-is; this outer
  // one is what makes clicking the header actually expand/collapse the
  // card, and what keeps it from spanning the full chat width.
  card.className = 'rag-context-card memory-ctx-card';

  const chunksHtml = chunks.map((c) => {
    const tagBadges = (Array.isArray(c.tags) ? c.tags : [])
      .map(t => `<span class="rag-point-idx">${_esc_mem(t)}</span>`).join('');
    return `
    <div class="rag-ctx-chunk">
      <div class="rag-ctx-chunk-meta">
        ${tagBadges}
        <span class="rag-result-score">score ${(c.score || 0).toFixed(3)}</span>
      </div>
      <div class="rag-ctx-chunk-text">${_esc_mem((c.text || '').slice(0, 400))}${(c.text || '').length > 400 ? '…' : ''}</div>
    </div>`;
  }).join('');

  card.innerHTML = `
    <div class="rag-ctx-header">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 0-4 4v1.17A5 5 0 0 0 5 12v6a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-6a5 5 0 0 0-3-4.83V6a4 4 0 0 0-4-4z"/></svg>
      <span class="rag-ctx-label">Memory</span>
      <span class="rag-ctx-count">${chunks.length} recalled</span>
      <svg class="rag-ctx-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="rag-ctx-body">${chunksHtml}</div>`;

  card.querySelector('.rag-ctx-header').addEventListener('click', () => {
    card.classList.toggle('expanded');
  });

  const lastMsg = msgList.lastElementChild;
  if (lastMsg && lastMsg.classList.contains('msg')) {
    msgList.insertBefore(card, lastMsg);
  } else {
    msgList.appendChild(card);
  }
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Connection details for the save_memory / search_memory tools when a turn
 * is handed off to the backend job queue — merged into the same "extraBody"
 * object chat.js already builds from getRagToolBackendPayload() (see
 * chat.js's generateChatBackend() call site).
 */
function getMemoryToolBackendPayload() {
  if (typeof MEMORY_ENABLED !== 'undefined' && !MEMORY_ENABLED) return {};
  return {
    memory_embed_model:  RAG_EMBED_MODEL,
    memory_embed_flavor: RAG_EMBED_FLAVOR,
    memory_qdrant_url:   RAG_QDRANT_URL,
    memory_min_score:    (typeof MEMORY_MIN_SCORE === 'number') ? MEMORY_MIN_SCORE : 0.55,
  };
}

window.injectMemoryContext        = injectMemoryContext;
window.renderMemoryContextCard    = renderMemoryContextCard;
window.getMemoryToolBackendPayload = getMemoryToolBackendPayload;

// ── Management-panel API helpers ────────────────────────────────────────
// Thin wrappers around /api/memory/*, called by settings.js's
// _initMemorySection() so the browse/edit/delete UI lives entirely in
// Settings while the actual HTTP calls stay here with the rest of the
// memory logic — same division of labour as rag.js vs settings.js.

/** Returns {entries: [...], count}. Each entry: {id, text, tags, source, confidence, created, updated}. */
async function fetchMemoryList() {
  const resp = await fetch('/api/memory/list', { headers: _memoryHeaders() });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** Patch = {text?, tags?, confidence?}. Only provided fields are changed. */
async function updateMemoryEntry(id, patch) {
  const resp = await fetch(`/api/memory/${encodeURIComponent(id)}`, {
    method:  'PUT',
    headers: _memoryHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      ...patch,
      embed_model:  RAG_EMBED_MODEL,
      embed_flavor: RAG_EMBED_FLAVOR,
      ollama_base:  OLLAMA_BASE,
      qdrant_url:   RAG_QDRANT_URL,
    }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function deleteMemoryEntry(id) {
  const resp = await fetch(`/api/memory/${encodeURIComponent(id)}?qdrant_url=${encodeURIComponent(RAG_QDRANT_URL)}`, {
    method: 'DELETE',
    headers: _memoryHeaders(),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

window.fetchMemoryList    = fetchMemoryList;
window.updateMemoryEntry  = updateMemoryEntry;
window.deleteMemoryEntry  = deleteMemoryEntry;

// ── Model-bar toggle (mirrors #think-toggle-wrap) ───────────────────────
// Markup lives in index.html right next to think-toggle-wrap. Wired here
// rather than settings.js since it's chat-runtime state, not a Settings
// modal field — same split as how thinkToggle itself is presumably wired
// in main.js, not settings.js.
//
// IMPORTANT: the highlighted/active color (styles.css: .think-label.think-active)
// is NOT a pure `:has(input:checked)` CSS rule — it's a JS-toggled class on
// the <label>. Setting cb.checked alone (what the previous version of this
// function did) changes the checkbox state but never touches that class, so
// the icon color never updated even though the toggle itself worked.
function _syncMemoryToggleUI(enabled) {
  const cb    = document.getElementById('memory-toggle');
  const label = document.getElementById('memory-toggle-label');
  if (cb)    cb.checked = enabled;
  if (label) label.classList.toggle('think-active', enabled);
}
window._syncMemoryToggleUI = _syncMemoryToggleUI;

(function _wireMemoryModelBarToggle() {
  function _wire() {
    const cb = document.getElementById('memory-toggle');
    if (!cb) return;
    _syncMemoryToggleUI((typeof MEMORY_ENABLED !== 'undefined') ? MEMORY_ENABLED : true);
    cb.addEventListener('change', () => {
      MEMORY_ENABLED = cb.checked;
      localStorage.setItem('memory_enabled', MEMORY_ENABLED);
      _syncMemoryToggleUI(MEMORY_ENABLED);
      // Keep the Settings → Memory checkbox (if the modal happens to be
      // open) in sync, and vice versa — see _initMemorySection in settings.js.
      const settingsCb = document.getElementById('set-memory-enabled');
      if (settingsCb) settingsCb.checked = MEMORY_ENABLED;
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wire);
  } else {
    _wire();
  }
})();

// ── SSE hook for the 'memory-saved' event ───────────────────────────────
// Only needed for the backend-offloaded path: save_memory there executes
// server-side (server.py's _execute_save_memory_tool), so the browser has
// no other way to learn a save happened. Uses the exact same "own
// EventSource" trick as rag.js's _hookRagSseEvent() — deliberately NOT
// monkey-patching backend.js's SSE handler, for the same reasons documented
// there (instanceof checks, paste-handler interference).
(function _hookMemorySseEvent() {
  let _memEs = null;
  let _memEsRetryTimer = null;

  function _openMemoryEventSource() {
    if (_memEs && _memEs.readyState !== EventSource.CLOSED) return;
    const cid = getEffectiveClientId();
    _memEs = new EventSource(`/api/events?client_id=${encodeURIComponent(cid)}`);

    _memEs.addEventListener('message', function(raw) {
      try {
        const evt = JSON.parse(raw.data);
        if (evt && evt.type === 'memory-saved') {
          if (typeof showToast === 'function') {
            showToast(`Saved to memory: "${(evt.text || '').slice(0, 60)}${(evt.text || '').length > 60 ? '…' : ''}"`, 2500);
          }
        }
      } catch (_) {}
    });

    _memEs.onerror = function() {
      _memEs.close();
      clearTimeout(_memEsRetryTimer);
      _memEsRetryTimer = setTimeout(_openMemoryEventSource, 3000);
    };
  }

  function _tryOpen() {
    if (typeof BACKEND_AVAILABLE !== 'undefined' && BACKEND_AVAILABLE) {
      _openMemoryEventSource();
    } else {
      setTimeout(_tryOpen, 2000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _tryOpen);
  } else {
    _tryOpen();
  }
})();
