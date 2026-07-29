// ══ RAG.JS ════════════════════════════════════════════════════
// Frontend controller for the RAG (Retrieval-Augmented Generation) mode.
//
// Responsibilities:
//   - Collection management UI (list, create, delete)
//   - File upload / drag-and-drop with ingestion progress (SSE)
//   - Search/query interface to test a collection
//   - Exports: ragCollections (live array), getActiveRagCollection()
//              refreshRagCollections() — called from chat.js for the dropdown
//
// Load order: after main.js, before chat.js
// Globals consumed: OLLAMA_BASE, RAG_QDRANT_URL, RAG_EMBED_MODEL,
//                   RAG_EMBED_FLAVOR (all from config.js)

// ── RAG config defaults (set in config.js) ────────────────────
// These are referenced here but declared in config.js:
//   RAG_QDRANT_URL, RAG_EMBED_MODEL, RAG_EMBED_FLAVOR

// ── State ─────────────────────────────────────────────────────
let ragCollections = [];       // [{name, points_count, dimension, distance}, …]
let _ragIngestAbort = null;    // AbortController for active SSE ingest stream
let _ragCurrentCollection = localStorage.getItem('rag_active_collection') || '';

// RAG mode for the Chat view — one of 'off' | 'always' | 'tool'.
//   off    — RAG is disabled entirely.
//   always — every turn auto-retrieves top-K chunks for the raw user
//            message and injects them into the system prompt (legacy behaviour).
//   tool   — the model is given a `rag_search` tool and decides itself
//            whether/when to call it, with its own query + top_k.
let RAG_MODE = localStorage.getItem('rag_mode') || 'off';
if (!['off', 'always', 'tool'].includes(RAG_MODE)) RAG_MODE = 'off';

function getRagMode() { return RAG_MODE; }

function setRagMode(mode) {
  if (!['off', 'always', 'tool'].includes(mode)) return;
  RAG_MODE = mode;
  localStorage.setItem('rag_mode', RAG_MODE);

  document.querySelectorAll('#rag-mode-group .toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.ragMode === mode);
  });

  const sel = document.getElementById('rag-collection-select');
  if (sel) sel.style.display = (mode === 'off') ? 'none' : '';
}

function getActiveRagCollection() { return _ragCurrentCollection; }

// ── DOM refs ──────────────────────────────────────────────────
const ragMode            = document.getElementById('rag-mode');
const ragCollectionList  = document.getElementById('rag-collection-list');
const ragNewColName      = document.getElementById('rag-new-col-name');
const ragNewColDim       = document.getElementById('rag-new-col-dim');
const ragNewColDist      = document.getElementById('rag-new-col-dist');
const ragCreateColBtn    = document.getElementById('rag-create-col-btn');
const ragDropZone        = document.getElementById('rag-drop-zone');
const ragFileInput       = document.getElementById('rag-file-input');
const ragIngestCollection= document.getElementById('rag-ingest-collection');
const ragEmbedModel      = document.getElementById('rag-embed-model');
const ragEmbedFlavor     = document.getElementById('rag-embed-flavor');
const ragChunkSize       = document.getElementById('rag-chunk-size');
const ragChunkOverlap    = document.getElementById('rag-chunk-overlap');
const ragChunkStrategy   = document.getElementById('rag-chunk-strategy');
const ragChapterHeadingPreset = document.getElementById('rag-chapter-heading-preset');
const ragChapterHeadingRegex  = document.getElementById('rag-chapter-heading-regex');
const ragChapterFallback      = document.getElementById('rag-chapter-fallback'); // hidden input
const ragChapterBreadcrumbSep = document.getElementById('rag-chapter-breadcrumb-sep');
const ragProbeDimBtn     = document.getElementById('rag-probe-dim-btn');
const setRagEmbedModelSel= document.getElementById('set-rag-embed-model');
const setRagEmbedRefresh = document.getElementById('set-rag-embed-model-refresh');
const ragUploadBtn       = document.getElementById('rag-upload-btn');
const ragIngestProgress  = document.getElementById('rag-ingest-progress');
const ragIngestLog       = document.getElementById('rag-ingest-log');
const ragIngestStopBtn   = document.getElementById('rag-ingest-stop-btn');
const ragSearchInput     = document.getElementById('rag-search-input');
const ragSearchBtn       = document.getElementById('rag-search-btn');
const ragSearchCollection= document.getElementById('rag-search-collection');
const ragSearchTopK      = document.getElementById('rag-search-topk');
const ragSearchResults   = document.getElementById('rag-search-results');
const ragRefreshBtn      = document.getElementById('rag-refresh-btn');
const ragQdrantStatus    = document.getElementById('rag-qdrant-status');

// ── Utilities ─────────────────────────────────────────────────
function _ragBackendBase() {
  // Requests go to the Python backend (same origin when behind nginx)
  return '';
}

function _ragShowError(msg) {
  if (ragIngestLog) {
    ragIngestLog.innerHTML += `<div class="rag-log-error">⚠ ${_esc(msg)}</div>`;
    ragIngestLog.scrollTop = ragIngestLog.scrollHeight;
  }
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Direct (no-backend) Qdrant + Ollama client ──────────────────────────
// Every RAG operation used to unconditionally call this app's own
// /api/rag/* endpoints (server.py) — which don't exist when the backend
// isn't running, so with BACKEND_AVAILABLE === false, RAG silently failed
// even with a perfectly valid Qdrant URL (surfaced in the UI as "Qdrant
// unreachable" even though the browser never actually tried to reach
// Qdrant). These helpers talk to Qdrant's REST API and Ollama's embedding
// endpoint directly from the browser instead, mirroring rag.py's
// _embed_ollama/_embed_openai and the /search + /collections handlers
// closely enough to return the same shape.
//
// Scope: retrieval only (list collections, search). Ingestion, collection
// create/delete, and field sampling still require the Python backend (PDF
// parsing, chunking strategies, batched upserts) and are NOT implemented
// here — those calls stay backend-only.
//
// REQUIRES: Qdrant's CORS enabled (service.enable_cors: true in Qdrant's
// config, or QDRANT__SERVICE__ENABLE_CORS=true), since the browser now
// calls Qdrant cross-origin directly. Also requires Qdrant >= 1.10 for the
// Query API endpoint used below (the same endpoint qdrant-client's
// query_points() calls server-side in rag.py).
function _ragDirectMode() {
  return typeof BACKEND_AVAILABLE === 'undefined' || !BACKEND_AVAILABLE;
}

async function _embedOllamaDirect(texts, model, baseUrl) {
  const base = (baseUrl || '').replace(/\/$/, '');
  try {
    const resp = await fetch(`${base}/api/embed`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model, input: texts }),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.embeddings) return data.embeddings;
    }
  } catch (_) {}
  // Fallback: one request per text (older Ollama builds without /api/embed)
  const results = [];
  for (const text of texts) {
    const resp = await fetch(`${base}/api/embeddings`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model, prompt: text }),
    });
    if (!resp.ok) throw new Error(`Ollama embeddings HTTP ${resp.status}`);
    const data = await resp.json();
    results.push(data.embedding);
  }
  return results;
}

async function _embedOpenaiDirect(texts, model, baseUrl) {
  const base = (baseUrl || '').replace(/\/$/, '');
  const resp = await fetch(`${base}/v1/embeddings`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model, input: texts }),
  });
  if (!resp.ok) throw new Error(`OpenAI embeddings HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.data || []).map(item => item.embedding);
}

async function _embedDirect(texts, model, baseUrl, flavor) {
  return flavor === 'openai'
    ? _embedOpenaiDirect(texts, model, baseUrl)
    : _embedOllamaDirect(texts, model, baseUrl);
}

// JS port of rag.py's _resolve_payload() — same field-name candidates, so
// a chunk retrieved directly looks identical to one retrieved via the
// backend, regardless of which ingestion strategy originally wrote it.
const _RAG_TEXT_FIELDS   = ['text', 'content', 'page_content', 'body', 'chunk', 'passage', 'document', 'value'];
const _RAG_SOURCE_FIELDS = ['source', 'filename', 'file', 'url', 'title', 'name', 'origin', 'path', 'document_id', 'doc_id'];
const _RAG_INDEX_FIELDS  = ['chunk_index', 'chunk_id', 'index', 'seq', 'sequence', 'order', 'position', 'page'];

function _resolveRagPayloadDirect(payload) {
  if (!payload) return { text: '', source: '', chunk_index: null };
  const meta = (payload.metadata && typeof payload.metadata === 'object') ? payload.metadata : {};

  const first = (keys, ...dicts) => {
    for (const d of dicts) {
      for (const k of keys) {
        const v = d[k];
        if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
      }
    }
    return null;
  };

  let text = first(_RAG_TEXT_FIELDS, payload, meta);
  if (!text) {
    const flat = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k !== 'metadata' && (typeof v !== 'object' || v === null)) flat[k] = v;
    }
    text = JSON.stringify(Object.keys(flat).length ? flat : payload, null, 2);
  }

  let source = first(_RAG_SOURCE_FIELDS, payload, meta) || '';
  if (!source) {
    for (const [k, v] of Object.entries({ ...payload, ...meta })) {
      if (typeof v === 'string' && v.length > 3 && v.length < 80 && !['content', 'text', 'body'].includes(k.toLowerCase())) {
        source = `${k}: ${v}`;
        break;
      }
    }
  }

  const idxRaw = first(_RAG_INDEX_FIELDS, payload, meta);
  const chunk_index = (idxRaw !== null && /^\d+$/.test(idxRaw)) ? parseInt(idxRaw, 10) : null;

  const strField = (key) => {
    const v = payload[key] ?? meta[key];
    return (v !== undefined && v !== null) ? String(v).trim() : '';
  };

  const result = {
    text, source, chunk_index,
    page:          strField('page'),
    section_title: strField('section_title'),
    breadcrumb:    strField('breadcrumb'),
    csv_headers:   payload.csv_headers || meta.csv_headers || [],
    json_key:      payload.json_key !== undefined ? payload.json_key : meta.json_key,
  };

  const known = new Set(['metadata', ..._RAG_TEXT_FIELDS, ..._RAG_SOURCE_FIELDS, ..._RAG_INDEX_FIELDS,
    'page', 'section_title', 'breadcrumb', 'csv_headers', 'json_key']);
  for (const [k, v] of Object.entries(meta))    { if (!known.has(k) && !(k in result)) result[k] = v; }
  for (const [k, v] of Object.entries(payload)) { if (!known.has(k)) result[k] = v; }
  return result;
}

/** Direct Qdrant search — mirrors rag.py's /search using Qdrant's Query
 *  API (POST /collections/{name}/points/query), the same endpoint
 *  qdrant-client's query_points() calls server-side. */
async function _qdrantSearchDirect(qdrantUrl, collection, queryVec, topK, scoreThreshold) {
  const base = (qdrantUrl || '').replace(/\/$/, '');
  const resp = await fetch(`${base}/collections/${encodeURIComponent(collection)}/points/query`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: queryVec,
      limit: topK,
      with_payload: true,
      score_threshold: (scoreThreshold && scoreThreshold > 0) ? scoreThreshold : null,
    }),
  });
  if (!resp.ok) throw new Error(`Qdrant search HTTP ${resp.status}`);
  const data = await resp.json();
  const points = (data.result && data.result.points) || [];
  return points.map(p => ({
    id:    String(p.id),
    score: Math.round((p.score || 0) * 1e6) / 1e6,
    ..._resolveRagPayloadDirect(p.payload || {}),
  }));
}

/**
 * Direct-mode replacement for POST /api/rag/search. Embeds params.query via
 * Ollama/OpenAI and searches Qdrant directly. Returns the same
 * {results: [...]} shape the backend endpoint returns, so every call site
 * (search tab, injectRagContext, executeRagSearchTool) can stay agnostic
 * to which mode actually ran.
 */
async function _ragSearchDirect(params) {
  const vecs = await _embedDirect([params.query], params.embed_model, params.ollama_base, params.embed_flavor);
  const results = await _qdrantSearchDirect(
    params.qdrant_url, params.collection, vecs[0], params.top_k, params.score_threshold || 0
  );
  return { results };
}

/** Direct-mode replacement for GET /api/rag/collections. */
async function _ragListCollectionsDirect(qdrantUrl) {
  const base = (qdrantUrl || '').replace(/\/$/, '');
  const resp = await fetch(`${base}/collections`);
  if (!resp.ok) throw new Error(`Qdrant HTTP ${resp.status}`);
  const data = await resp.json();
  const names = ((data.result && data.result.collections) || []).map(c => c.name);
  const collections = await Promise.all(names.map(async (name) => {
    try {
      const infoResp = await fetch(`${base}/collections/${encodeURIComponent(name)}`);
      if (!infoResp.ok) throw new Error(`HTTP ${infoResp.status}`);
      const info = (await infoResp.json()).result || {};
      const vectors = info.config?.params?.vectors;
      let dim = '?', dist = '?';
      if (vectors && typeof vectors.size !== 'undefined') {
        dim = vectors.size; dist = vectors.distance;
      } else if (vectors && typeof vectors === 'object') {
        const firstVec = Object.values(vectors)[0];
        if (firstVec) { dim = firstVec.size; dist = firstVec.distance; }
      }
      return {
        name,
        points_count: info.points_count ?? info.vectors_count ?? 0,
        dimension:    dim,
        distance:     dist,
        status:       info.status || '?',
      };
    } catch (e) {
      return { name, error: e.message };
    }
  }));
  return { collections };
}

/**
 * Direct-mode replacement for GET /api/rag/embed-models. Lists models from
 * Ollama's /api/tags (or an OpenAI-compatible /v1/models) and filters down
 * to likely embedding models using the exact same keyword list rag.py's
 * list_embed_models() uses server-side, so the dropdown shows the same
 * models either way — this is what was missing: without the backend, this
 * endpoint doesn't exist, so the catch(_){} in _loadEmbedModels() silently
 * left the dropdown on its single hardcoded RAG_EMBED_MODEL fallback
 * ("nomic-embed-text"), even though e.g. bge-m3 was installed and visible
 * in the model status window (which talks to Ollama directly, same as this).
 */
const _RAG_EMBED_KEYWORDS = [
  'embed', 'embedding', 'minilm', 'bge-', 'e5-', 'gte-',
  'instructor', 'all-minilm', 'paraphrase', 'multilingual', 'sentence',
];

function _isEmbedModelName(name) {
  const n = (name || '').toLowerCase();
  return _RAG_EMBED_KEYWORDS.some(kw => n.includes(kw));
}

async function _listEmbedModelsDirect(ollamaBase, flavor) {
  const base = (ollamaBase || '').replace(/\/$/, '');
  try {
    let allModels = [];
    if (flavor === 'openai') {
      const resp = await fetch(`${base}/v1/models`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      allModels = (data.data || []).map(m => m.id);
    } else {
      const resp = await fetch(`${base}/api/tags`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      allModels = (data.models || []).map(m => m.name);
    }
    // Same fallback logic as rag.py: if the keyword filter matches nothing
    // (e.g. a non-standard embed model name), show the full list rather
    // than an empty dropdown.
    const filtered = allModels.filter(_isEmbedModelName);
    return { models: filtered.length ? filtered : allModels };
  } catch (e) {
    return { models: [], error: e.message };
  }
}

/** Direct-mode replacement for GET /api/rag/probe-dimension. */
async function _probeDimensionDirect(model, ollamaBase, flavor) {
  const vecs = await _embedDirect(['hello'], model, ollamaBase, flavor);
  if (!vecs || !vecs[0] || !vecs[0].length) throw new Error('Empty embedding returned');
  return { dimension: vecs[0].length, model };
}

// ── Collection management ─────────────────────────────────────
async function refreshRagCollections() {
  try {
    const data = _ragDirectMode()
      ? await _ragListCollectionsDirect(RAG_QDRANT_URL)
      : await (async () => {
          const resp = await fetch(`${_ragBackendBase()}/api/rag/collections?qdrant_url=${encodeURIComponent(RAG_QDRANT_URL)}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return resp.json();
        })();
    ragCollections = data.collections || [];
    _renderCollectionList();
    _populateCollectionSelects();
    _updateQdrantStatus(true);
  } catch (e) {
    _updateQdrantStatus(false, e.message);
    ragCollections = [];
    _renderCollectionList();
    _populateCollectionSelects();
  }
}

function _updateQdrantStatus(ok, msg) {
  if (!ragQdrantStatus) return;
  ragQdrantStatus.className = 'rag-qdrant-status ' + (ok ? 'online' : 'error');
  ragQdrantStatus.textContent = ok
    ? `✓ Qdrant connected — ${RAG_QDRANT_URL}`
    : `✗ Qdrant unreachable — ${msg || RAG_QDRANT_URL}`;
}

function _renderCollectionList() {
  if (!ragCollectionList) return;
  if (!ragCollections.length) {
    ragCollectionList.innerHTML = '<div class="rag-empty">No collections yet. Create one below.</div>';
    return;
  }
  ragCollectionList.innerHTML = ragCollections.map(col => `
    <div class="rag-col-item" data-name="${_esc(col.name)}">
      <div class="rag-col-info">
        <span class="rag-col-name">${_esc(col.name)}</span>
        <span class="rag-col-meta">
          ${col.points_count ?? 0} chunks &middot; dim ${col.dimension ?? '?'} &middot; ${col.distance ?? '?'}
        </span>
      </div>
      <div class="rag-col-actions">
        <button class="icon-btn rag-col-inspect-btn" data-name="${_esc(col.name)}" title="Inspect chunks">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        </button>
        <button class="icon-btn rag-col-delete-btn" data-name="${_esc(col.name)}" title="Delete collection" style="color:var(--red)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>
    </div>
  `).join('');

  ragCollectionList.querySelectorAll('.rag-col-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => _deleteCollection(btn.dataset.name));
  });
  ragCollectionList.querySelectorAll('.rag-col-inspect-btn').forEach(btn => {
    btn.addEventListener('click', () => _inspectCollection(btn.dataset.name));
  });
}

function _populateCollectionSelects() {
  const names = ragCollections.map(c => c.name);
  [ragIngestCollection, ragSearchCollection].forEach(sel => {
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = names.length
      ? names.map(n => `<option value="${_esc(n)}"${n===prev?' selected':''}>${_esc(n)}</option>`).join('')
      : '<option value="" disabled selected>No collections</option>';
  });

  // Also update the chat-mode RAG dropdown. No "No RAG" placeholder anymore —
  // that's now the separate Off/Always/Tool toggle group; this select only
  // ever lists actual collections.
  const chatRagSel = document.getElementById('rag-collection-select');
  if (chatRagSel) {
    const prevChat = chatRagSel.value;
    chatRagSel.innerHTML = names.length
      ? names.map(n => `<option value="${_esc(n)}"${n===prevChat?' selected':''}>${_esc(n)}</option>`).join('')
      : '<option value="" disabled selected>No collections</option>';
    if (!prevChat && _ragCurrentCollection && names.includes(_ragCurrentCollection))
      chatRagSel.value = _ragCurrentCollection;
  }

  // Settings → RAG "fetch fields" collection picker
  const fieldSel = document.getElementById('set-rag-field-collection');
  if (fieldSel) {
    const prevField = fieldSel.value;
    fieldSel.innerHTML = '<option value="">— select collection —</option>' +
      names.map(n => `<option value="${_esc(n)}"${n===prevField?' selected':''}>${_esc(n)}</option>`).join('');
    if (!prevField && _ragCurrentCollection && names.includes(_ragCurrentCollection))
      fieldSel.value = _ragCurrentCollection;
  }
}

async function _createCollection() {
  const name = ragNewColName?.value.trim();
  if (!name) { _ragShowError('Collection name required.'); return; }
  const dim  = parseInt(ragNewColDim?.value)  || 768;
  const dist = ragNewColDist?.value           || 'Cosine';
  try {
    ragCreateColBtn.disabled = true;
    const resp = await fetch('/api/rag/collections', {
      method:  'POST',
      headers: {'Content-Type': 'application/json'},
      body:    JSON.stringify({ name, dimension: dim, distance: dist, qdrant_url: RAG_QDRANT_URL }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || 'Failed');
    if (ragNewColName) ragNewColName.value = '';
    await refreshRagCollections();
    showToast(`Collection "${name}" created`, 'success');
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  } finally {
    if (ragCreateColBtn) ragCreateColBtn.disabled = false;
  }
}

async function _deleteCollection(name) {
  if (!confirm(`Delete collection "${name}" and ALL its vectors? This cannot be undone.`)) return;
  try {
    const resp = await fetch(`/api/rag/collections/${encodeURIComponent(name)}?qdrant_url=${encodeURIComponent(RAG_QDRANT_URL)}`, { method: 'DELETE' });
    if (!resp.ok) { const d = await resp.json(); throw new Error(d.detail || 'Failed'); }
    await refreshRagCollections();
    showToast(`Collection "${name}" deleted`, 'success');
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  }
}

// ── Inspect modal ─────────────────────────────────────────────
async function _inspectCollection(name) {
  const modal = document.getElementById('rag-inspect-modal');
  const title = document.getElementById('rag-inspect-title');
  const body  = document.getElementById('rag-inspect-body');
  if (!modal) return;
  title.textContent = `Collection: ${name}`;
  body.innerHTML = '<div class="rag-loading">Loading…</div>';
  modal.classList.remove('hidden');
  try {
    const resp = await fetch(`/api/rag/collections/${encodeURIComponent(name)}/points?limit=50&qdrant_url=${encodeURIComponent(RAG_QDRANT_URL)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || 'Failed');
    const points = data.points || [];
    if (!points.length) { body.innerHTML = '<div class="rag-empty">No points in this collection.</div>'; return; }
    body.innerHTML = points.map(p => {
      let metaBadges = '';
      if (p.page)          metaBadges += `<span class="rag-point-idx">Seite ${_esc(p.page)}</span>`;
      if (p.section_title) metaBadges += `<span class="rag-point-idx">${_esc(p.section_title)}</span>`;
      if (p.json_key != null) metaBadges += `<span class="rag-point-idx">elem[${_esc(String(p.json_key))}]</span>`;
      if (!metaBadges && p.chunk_index != null)
                           metaBadges += `<span class="rag-point-idx">chunk #${p.chunk_index}</span>`;
      const preview = (p.text || p.payload?.text || p.payload?.content || '');
      return `
      <div class="rag-point-card">
        <div class="rag-point-meta">
          <span class="rag-point-source">${_esc(p.source || p.payload?.source || '?')}</span>
          ${metaBadges}
        </div>
        <div class="rag-point-text">${_esc(preview.slice(0, 300))}${preview.length > 300 ? '…' : ''}</div>
      </div>`;
    }).join('');
    if (data.next_offset) {
      body.innerHTML += `<div class="rag-empty" style="text-align:center;padding:8px 0">Showing first 50 chunks. More exist.</div>`;
    }
  } catch (e) {
    body.innerHTML = `<div class="rag-log-error">Error: ${_esc(e.message)}</div>`;
  }
}

// ── File ingestion ────────────────────────────────────────────
function _setupDropZone() {
  if (!ragDropZone) return;
  ragDropZone.addEventListener('dragover', e => { e.preventDefault(); ragDropZone.classList.add('drag-over'); });
  ragDropZone.addEventListener('dragleave', () => ragDropZone.classList.remove('drag-over'));
  ragDropZone.addEventListener('drop', e => {
    e.preventDefault();
    ragDropZone.classList.remove('drag-over');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) _startIngest(files);
  });
  ragDropZone.addEventListener('click', () => ragFileInput?.click());
  if (ragFileInput) {
    ragFileInput.addEventListener('change', () => {
      const files = [...(ragFileInput.files || [])];
      if (files.length) _startIngest(files);
      ragFileInput.value = '';
    });
  }
}

async function _startIngest(files) {
  const collection = ragIngestCollection?.value;
  if (!collection) { showToast('Select a collection first.', 'error'); return; }

  if (ragIngestProgress) ragIngestProgress.classList.remove('hidden');
  if (ragIngestLog) ragIngestLog.innerHTML = '';
  if (ragUploadBtn)     ragUploadBtn.classList.add('hidden');
  if (ragIngestStopBtn) ragIngestStopBtn.classList.remove('hidden');

  for (const file of files) {
    await _ingestFile(file, collection);
    if (_ragIngestAbort?.signal.aborted) break;
  }

  if (ragUploadBtn)     ragUploadBtn.classList.remove('hidden');
  if (ragIngestStopBtn) ragIngestStopBtn.classList.add('hidden');
  _ragIngestAbort = null;
  await refreshRagCollections();
}

async function _ingestFile(file, collection) {
  _ragIngestAbort = new AbortController();
  // Persist current field values so they survive page reload
  if (window._ragLoadIngestPrefs) {
    // Save current values (fields are live at this point)
    const saveFields = [
      ['rag_embed_flavor',   ragEmbedFlavor?.value],
      ['rag_embed_model',    ragEmbedModel?.value],
      ['rag_chunk_size',     ragChunkSize?.value],
      ['rag_chunk_overlap',  ragChunkOverlap?.value],
      ['rag_chunk_strategy', ragChunkStrategy?.value],
      ['rag_chapter_heading_preset', ragChapterHeadingPreset?.value],
      ['rag_chapter_heading_regex',  ragChapterHeadingRegex?.value],
      ['rag_chapter_fallback',       ragChapterFallback?.value],
      ['rag_chapter_breadcrumb_sep', ragChapterBreadcrumbSep?.value],
    ];
    saveFields.forEach(([k, v]) => { if (v !== undefined && v !== null) localStorage.setItem(k, v); });
  }
  const fd = new FormData();
  fd.append('file',           file);
  fd.append('collection',     collection);
  fd.append('embed_model',    ragEmbedModel?.value  || RAG_EMBED_MODEL);
  fd.append('embed_flavor',   ragEmbedFlavor?.value || RAG_EMBED_FLAVOR);
  fd.append('ollama_base',    OLLAMA_BASE);
  fd.append('qdrant_url',     RAG_QDRANT_URL);
  fd.append('chunk_size',     ragChunkSize?.value    || 2000);
  fd.append('chunk_overlap',  ragChunkOverlap?.value || 200);
  fd.append('chunk_strategy', ragChunkStrategy?.value || 'recursive');
  fd.append('chapter_heading_preset', ragChapterHeadingPreset?.value || 'auto');
  fd.append('chapter_heading_regex',  ragChapterHeadingRegex?.value  || '');
  fd.append('chapter_fallback',       ragChapterFallback?.value      || 'recursive');
  fd.append('chapter_breadcrumb_sep', ragChapterBreadcrumbSep?.value || ' > ');

  if (ragIngestLog) {
    ragIngestLog.innerHTML += `<div class="rag-log-section">📄 ${_esc(file.name)}</div>`;
  }

  try {
    const resp = await fetch('/api/rag/ingest', { method: 'POST', body: fd, signal: _ragIngestAbort.signal });
    if (!resp.ok) { const d = await resp.json(); throw new Error(d.detail || 'Ingest failed'); }

    const reader = resp.body.getReader();
    const dec    = new TextDecoder();
    let buf      = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim());
          _handleIngestEvent(evt);
        } catch (_) {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') _ragShowError(e.message);
  }
}

function _handleIngestEvent(evt) {
  if (!ragIngestLog) return;
  const cls = evt.stage === 'error'   ? 'rag-log-error'
            : evt.stage === 'done'    ? 'rag-log-done'
            : evt.stage === 'warning' ? 'rag-log-warn'
            : 'rag-log-info';

  // Stages that emit repeated progress updates — update last line in-place
  const _UPDATE_IN_PLACE = new Set(['embedding', 'extracting', 'chunking', 'cleaning', 'upserting']);
  const last = ragIngestLog.lastElementChild;
  if (last && last.dataset.stage === evt.stage && _UPDATE_IN_PLACE.has(evt.stage)) {
    last.textContent = evt.message;
  } else {
    const div = document.createElement('div');
    div.className = cls;
    div.dataset.stage = evt.stage;
    div.textContent = evt.message;
    ragIngestLog.appendChild(div);
  }
  ragIngestLog.scrollTop = ragIngestLog.scrollHeight;
}

// ── Search/Test ───────────────────────────────────────────────
async function _doSearch() {
  const query = ragSearchInput?.value.trim();
  if (!query) return;
  const collection = ragSearchCollection?.value;
  if (!collection) { showToast('Select a collection to search.', 'error'); return; }

  if (ragSearchResults) ragSearchResults.innerHTML = '<div class="rag-loading">Searching…</div>';
  if (ragSearchBtn) ragSearchBtn.disabled = true;

  try {
    const searchParams = {
      collection,
      query,
      top_k:        parseInt(ragSearchTopK?.value) || 5,
      embed_model:  ragEmbedModel?.value  || RAG_EMBED_MODEL,
      embed_flavor: ragEmbedFlavor?.value || RAG_EMBED_FLAVOR,
      ollama_base:  OLLAMA_BASE,
      qdrant_url:   RAG_QDRANT_URL,
    };
    const data = _ragDirectMode()
      ? await _ragSearchDirect(searchParams)
      : await (async () => {
          const resp = await fetch('/api/rag/search', {
            method:  'POST',
            headers: {'Content-Type': 'application/json'},
            body:    JSON.stringify(searchParams),
          });
          const d = await resp.json();
          if (!resp.ok) throw new Error(d.detail || 'Search failed');
          return d;
        })();
    // Show exactly what the model would receive: apply the same
    // whitelist/blacklist field filter configured in Settings → RAG
    // (_filterRagFields always keeps text/score; everything else is subject
    // to the configured mode).
    const filtered = (data.results || []).map(_filterRagFields);
    _renderSearchResults(filtered);
  } catch (e) {
    if (ragSearchResults) ragSearchResults.innerHTML = `<div class="rag-log-error">Error: ${_esc(e.message)}</div>`;
  } finally {
    if (ragSearchBtn) ragSearchBtn.disabled = false;
  }
}

// Fields already shown prominently in the meta badge row — everything else
// present in a (filtered) result is rendered in the details grid below, so
// the test view always mirrors exactly what the model's rag_search tool
// would receive, whatever the Settings → RAG whitelist/blacklist allows.
const _RAG_BADGE_FIELDS = new Set([
  'source', 'breadcrumb', 'chapter_title', 'section_title',
  'page', 'book', 'chapter_number', 'chunk_index',
  'chunk_part', 'chunk_parts_total', 'json_key',
]);

function _renderSearchResults(results) {
  if (!ragSearchResults) return;
  if (!results.length) { ragSearchResults.innerHTML = '<div class="rag-empty">No results found.</div>'; return; }
  ragSearchResults.innerHTML = results.map((r, i) => {
    let metaBadges = '';
    if (r.source)         metaBadges += `<span class="rag-point-source">${_esc(r.source)}</span>`;
    if (r.breadcrumb)      metaBadges += `<span class="rag-point-idx">${_esc(r.breadcrumb)}</span>`;
    else if (r.chapter_title) metaBadges += `<span class="rag-point-idx">${_esc(r.chapter_title)}</span>`;
    if (r.page)           metaBadges += `<span class="rag-point-idx">Seite ${_esc(r.page)}</span>`;
    if (r.section_title && r.section_title !== r.breadcrumb)
                           metaBadges += `<span class="rag-point-idx">${_esc(r.section_title)}</span>`;
    if (r.json_key != null) metaBadges += `<span class="rag-point-idx">elem[${_esc(String(r.json_key))}]</span>`;
    if (r.chunk_part != null && r.chunk_parts_total != null)
                           metaBadges += `<span class="rag-point-idx">part ${_esc(String(r.chunk_part))}/${_esc(String(r.chunk_parts_total))}</span>`;
    if (!metaBadges && r.chunk_index != null)
                           metaBadges += `<span class="rag-point-idx">chunk #${r.chunk_index}</span>`;

    // Every remaining field in the (already whitelist/blacklist-filtered)
    // payload — id/text/score are handled separately, badge fields are
    // handled above, everything else the model would also see goes here.
    const detailRows = Object.entries(r)
      .filter(([k, v]) => !['id', 'text', 'score'].includes(k) && !_RAG_BADGE_FIELDS.has(k)
                        && v !== null && v !== undefined && v !== ''
                        && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => {
        const val = Array.isArray(v) ? v.join(', ') : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        return `<div style="display:flex;gap:6px;font-size:11px;line-height:1.5;">
                  <span style="color:var(--text-dim);flex-shrink:0;">${_esc(k)}:</span>
                  <span style="color:var(--text);word-break:break-word;">${_esc(val)}</span>
                </div>`;
      }).join('');

    return `
    <div class="rag-result-card">
      <div class="rag-result-meta">
        <span class="rag-result-rank">#${i+1}</span>
        <span class="rag-result-score">score: ${r.score.toFixed(4)}</span>
        ${metaBadges}
      </div>
      ${detailRows ? `<div style="display:flex;flex-direction:column;gap:2px;padding:6px 0;border-top:1px dashed var(--border);border-bottom:1px dashed var(--border);margin:4px 0;">${detailRows}</div>` : ''}
      <div class="rag-result-text">${_esc(r.text)}</div>
    </div>`;
  }).join('');
}

// ── Embed model list (populated from Ollama) ──────────────────
async function _loadEmbedModels() {
  if (!ragEmbedModel) return;
  try {
    const flavor = ragEmbedFlavor?.value || RAG_EMBED_FLAVOR;
    const data   = _ragDirectMode()
      ? await _listEmbedModelsDirect(OLLAMA_BASE, flavor)
      : await (await fetch(`/api/rag/embed-models?ollama_base=${encodeURIComponent(OLLAMA_BASE)}&flavor=${flavor}`)).json();
    const models = data.models || [];
    const prev   = localStorage.getItem('rag_embed_model') || ragEmbedModel.value || RAG_EMBED_MODEL;
    ragEmbedModel.innerHTML = models.length
      ? models.map(m => `<option value="${_esc(m)}"${m===prev?' selected':''}>${_esc(m.replace(/:latest$/,''))}</option>`).join('')
      : `<option value="${_esc(RAG_EMBED_MODEL)}">${_esc(RAG_EMBED_MODEL)}</option>`;
    // Restore saved selection now that options exist
    if (window._ragLoadIngestPrefs) window._ragLoadIngestPrefs();
    // Final fallback
    if (!ragEmbedModel.value) ragEmbedModel.value = RAG_EMBED_MODEL;
  } catch (_) {}
}

// ── Wiring ────────────────────────────────────────────────────
(function _initRag() {
  if (!ragMode) return;   // rag-mode div not in DOM yet — nothing to wire

  // Inject CSS for disabled ingest fields (once)
  if (!document.getElementById('rag-disabled-style')) {
    const s = document.createElement('style');
    s.id = 'rag-disabled-style';
    s.textContent = `
      .rag-field-disabled { opacity: 0.4; pointer-events: none; }
      .rag-field-disabled label { cursor: not-allowed; }
      .rag-field-disabled input, .rag-field-disabled select { cursor: not-allowed; }
    `;
    document.head.appendChild(s);
  }

  if (ragCreateColBtn) ragCreateColBtn.addEventListener('click', _createCollection);

  // ── Strategy-aware chunk controls ─────────────────────────────
  // For csv_rows and json_objects the chunk size / overlap fields are irrelevant.
  // Disable (not hide) them so the user can still see the full form.
  const _SIZELESS_STRATEGIES = new Set(['records', 'whole', 'csv_rows', 'json_objects']);

  function _updateChunkControls() {
    const strategy = ragChunkStrategy?.value || 'fixed';
    const sizeless  = _SIZELESS_STRATEGIES.has(strategy);
    const isChapter = strategy === 'chapter_aware';

    if (ragChunkSize) {
      ragChunkSize.disabled = sizeless;
      ragChunkSize.closest('.rag-form-row')?.classList.toggle('rag-field-disabled', sizeless);
    }
    if (ragChunkOverlap) {
      ragChunkOverlap.disabled = sizeless;
      ragChunkOverlap.closest('.rag-form-row')?.classList.toggle('rag-field-disabled', sizeless);
    }

    // Show chapter_aware-only controls: heading pattern, custom regex (only
    // when preset === 'custom'), breadcrumb separator, and the oversized-
    // chapter fallback method.
    const headingRow  = document.getElementById('rag-chapter-heading-row');
    const regexRow    = document.getElementById('rag-chapter-regex-row');
    const sepRow       = document.getElementById('rag-chapter-sep-row');
    const fallbackRow = document.getElementById('rag-chapter-fallback-row');
    if (headingRow)  headingRow.style.display  = isChapter ? 'contents' : 'none';
    if (sepRow)       sepRow.style.display      = isChapter ? 'contents' : 'none';
    if (fallbackRow) fallbackRow.style.display = isChapter ? 'contents' : 'none';
    if (regexRow) {
      const isCustom = ragChapterHeadingPreset?.value === 'custom';
      regexRow.style.display = (isChapter && isCustom) ? 'contents' : 'none';
    }

    // Update size label
    const sizeRow    = ragChunkSize?.closest('.rag-form-row') || ragChunkSize?.parentElement;
    const overlapRow = ragChunkOverlap?.closest('.rag-form-row') || ragChunkOverlap?.parentElement;
    const sizeLabel    = sizeRow?.querySelector('label');
    const overlapLabel = overlapRow?.querySelector('label');
    if (sizeLabel && !sizeless)
      sizeLabel.textContent = isChapter ? 'Max chars / chapter (before splitting)'
                             : 'Chunk size (chars)';
    if (overlapLabel && !sizeless) overlapLabel.textContent = 'Overlap (chars)';
  }

  if (ragChunkStrategy) {
    ragChunkStrategy.addEventListener('change', _updateChunkControls);
    _updateChunkControls();  // run once on init
  }
  if (ragChapterHeadingPreset) {
    ragChapterHeadingPreset.addEventListener('change', _updateChunkControls);
  }

  // Fallback-method toggle-group (Paragraph / Sentence / Fixed) — mirrors the
  // rag-mode-group pattern: click sets .active and syncs the hidden input
  // that actually gets submitted with the form.
  document.querySelectorAll('#rag-chapter-fallback-group .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#rag-chapter-fallback-group .toggle-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
      if (ragChapterFallback) {
        ragChapterFallback.value = btn.dataset.fallback || 'recursive';
        ragChapterFallback.dispatchEvent(new Event('change'));
      }
    });
  });

  // ── Persist ingest field values to localStorage ─────────────────────────
  // Keys and their corresponding DOM element references
  const _PERSIST_FIELDS = [
    { key: 'rag_embed_flavor',    el: () => ragEmbedFlavor    },
    { key: 'rag_embed_model',     el: () => ragEmbedModel     },
    { key: 'rag_chunk_size',      el: () => ragChunkSize      },
    { key: 'rag_chunk_overlap',   el: () => ragChunkOverlap   },
    { key: 'rag_chunk_strategy',  el: () => ragChunkStrategy  },
    { key: 'rag_chapter_heading_preset', el: () => ragChapterHeadingPreset },
    { key: 'rag_chapter_heading_regex',  el: () => ragChapterHeadingRegex  },
    { key: 'rag_chapter_fallback',       el: () => ragChapterFallback      },
    { key: 'rag_chapter_breadcrumb_sep', el: () => ragChapterBreadcrumbSep },
  ];

  function _saveIngestPrefs() {
    _PERSIST_FIELDS.forEach(({ key, el }) => {
      const elem = el();
      if (!elem) return;
      if (elem.type === 'checkbox') {
        localStorage.setItem(key, elem.checked ? '1' : '0');
      } else if (elem.value !== undefined) {
        localStorage.setItem(key, elem.value);
      }
    });
  }

  function _loadIngestPrefs() {
    _PERSIST_FIELDS.forEach(({ key, el }) => {
      const saved = localStorage.getItem(key);
      const elem  = el();
      if (saved === null || !elem) return;
      if (elem.type === 'checkbox') {
        elem.checked = saved === '1';
      } else if (elem.tagName === 'SELECT') {
        const exists = Array.from(elem.options).some(o => o.value === saved);
        if (exists) elem.value = saved;
      } else {
        elem.value = saved;
      }
    });
    // Sync the fallback toggle-group's .active button to the restored hidden value
    if (ragChapterFallback) {
      document.querySelectorAll('#rag-chapter-fallback-group .toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.fallback === ragChapterFallback.value);
      });
    }
    _updateChunkControls();
  }

  // Wire save on change for each field
  _PERSIST_FIELDS.forEach(({ key, el }) => {
    // Use a getter so we bind after DOM is ready
    const attach = () => {
      const elem = el();
      if (elem) elem.addEventListener('change', _saveIngestPrefs);
    };
    attach();
  });

  // Load saved prefs now (embed model options may not be loaded yet;
  // _loadEmbedModels() calls _loadIngestPrefs() after populating the list)
  _loadIngestPrefs();

  // Expose loader so _loadEmbedModels can call it after options are populated
  window._ragLoadIngestPrefs = _loadIngestPrefs;

  if (ragUploadBtn)    ragUploadBtn.addEventListener('click', () => ragFileInput?.click());
  if (ragIngestStopBtn) ragIngestStopBtn.addEventListener('click', () => {
    _ragIngestAbort?.abort();
    if (ragIngestLog) ragIngestLog.innerHTML += '<div class="rag-log-error">Stopped.</div>';
  });
  if (ragSearchBtn) ragSearchBtn.addEventListener('click', _doSearch);
  if (ragSearchInput) ragSearchInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _doSearch(); } });
  if (ragRefreshBtn) ragRefreshBtn.addEventListener('click', () => { refreshRagCollections(); _loadEmbedModels(); });
  if (ragEmbedFlavor) ragEmbedFlavor.addEventListener('change', _loadEmbedModels);

  // Probe dimension button
  if (ragProbeDimBtn) {
    ragProbeDimBtn.addEventListener('click', async () => {
      const model  = ragEmbedModel?.value || RAG_EMBED_MODEL;
      const flavor = ragEmbedFlavor?.value || RAG_EMBED_FLAVOR;
      ragProbeDimBtn.disabled = true;
      ragProbeDimBtn.textContent = '…';
      try {
        const data = _ragDirectMode()
          ? await _probeDimensionDirect(model, OLLAMA_BASE, flavor)
          : await (async () => {
              const resp = await fetch(
                `/api/rag/probe-dimension?model=${encodeURIComponent(model)}&ollama_base=${encodeURIComponent(OLLAMA_BASE)}&flavor=${encodeURIComponent(flavor)}`
              );
              const d = await resp.json();
              if (!resp.ok) throw new Error(d.detail || 'Failed');
              return d;
            })();
        if (ragNewColDim) ragNewColDim.value = data.dimension;
        showToast(`Dimension: ${data.dimension} (${model.replace(/:latest$/,'')})`, 'success');
      } catch (e) {
        showToast(`Probe failed: ${e.message}`, 'error');
      } finally {
        ragProbeDimBtn.disabled  = false;
        ragProbeDimBtn.textContent = 'probe';
      }
    });
  }

  // Settings modal embed model dropdown — fetch + refresh button
  async function _loadSettingsEmbedModels() {
    if (!setRagEmbedModelSel) return;
    const flavor = document.getElementById('set-rag-embed-flavor')?.value || RAG_EMBED_FLAVOR;
    const prev   = setRagEmbedModelSel.value || RAG_EMBED_MODEL;
    try {
      const data = _ragDirectMode()
        ? await _listEmbedModelsDirect(OLLAMA_BASE, flavor)
        : await (await fetch(`/api/rag/embed-models?ollama_base=${encodeURIComponent(OLLAMA_BASE)}&flavor=${encodeURIComponent(flavor)}`)).json();
      const models = data.models || [];
      if (models.length) {
        setRagEmbedModelSel.innerHTML = models.map(m =>
          `<option value="${_esc(m)}"${m === prev ? ' selected' : ''}>${_esc(m.replace(/:latest$/, ''))}</option>`
        ).join('');
      }
      if (!setRagEmbedModelSel.value) setRagEmbedModelSel.value = prev;
    } catch (_) {}
  }

  if (setRagEmbedRefresh) {
    setRagEmbedRefresh.addEventListener('click', _loadSettingsEmbedModels);
  }
  document.getElementById('set-rag-embed-flavor')?.addEventListener('change', _loadSettingsEmbedModels);

  // Expose so settings.js can trigger this at the actual moment the modal
  // opens (in the settings-open-btn click handler), instead of listening
  // for 'transitionend' — that event bubbles from ANY descendant whose CSS
  // transition finishes (button hover color/transform/etc.), which fired
  // this fetch on every single hover inside the modal. See settings.js.
  window.loadSettingsEmbedModels = _loadSettingsEmbedModels;

  // Inspect modal close
  document.getElementById('rag-inspect-close')?.addEventListener('click', () =>
    document.getElementById('rag-inspect-modal')?.classList.add('hidden')
  );
  document.getElementById('rag-inspect-modal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });

  _setupDropZone();

  // Populate embed model select with RAG_EMBED_MODEL as default fallback
  if (ragEmbedModel && !ragEmbedModel.options.length) {
    ragEmbedModel.innerHTML = `<option value="${_esc(RAG_EMBED_MODEL)}">${_esc(RAG_EMBED_MODEL)}</option>`;
  }

  // Persist chat-mode RAG selection
  const chatRagSel = document.getElementById('rag-collection-select');
  if (chatRagSel) {
    // Restore last saved selection
    if (RAG_ACTIVE_COLLECTION) chatRagSel.value = RAG_ACTIVE_COLLECTION;
    chatRagSel.addEventListener('change', () => {
      RAG_ACTIVE_COLLECTION = chatRagSel.value;
      localStorage.setItem('rag_active_collection', RAG_ACTIVE_COLLECTION);
    });
  }

  // Wire the Off / Always / Tool toggle group, and apply the restored mode
  // to both the button states and the collection-select visibility.
  document.querySelectorAll('#rag-mode-group .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => setRagMode(btn.dataset.ragMode));
  });
  setRagMode(RAG_MODE);

  // Initial load
  refreshRagCollections();
  _loadEmbedModels();
})();

// ── showToast helper (fallback if not defined by chat.js yet) ─
if (typeof showToast === 'undefined') {
  window.showToast = function(msg, type) {
    const tc = document.getElementById('toast-container');
    if (!tc) { console.log(msg); return; }
    const t = document.createElement('div');
    t.className = 'toast toast-' + (type || 'info');
    t.textContent = msg;
    tc.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  };
}

// ══ RAG CHAT INTEGRATION ══════════════════════════════════════
// These functions are called by chat.js / backend.js to wire RAG into
// the actual chat flow. They work regardless of whether BACKEND_AVAILABLE
// is true (backend path) or false (direct proxy path).

/**
 * Returns an object of RAG-related fields to merge into the
 * /api/generate-chat job body when BACKEND_AVAILABLE is true.
 * Returns {} when no collection is selected (no-op for the backend).
 */
function getRagPayload() {
  if (RAG_MODE !== 'always') return {};
  const sel = document.getElementById('rag-collection-select');
  const collection = sel ? sel.value : '';
  if (!collection) return {};
  return {
    rag_collection:   collection,
    rag_qdrant_url:   RAG_QDRANT_URL,
    rag_embed_model:  RAG_EMBED_MODEL,
    rag_embed_flavor: RAG_EMBED_FLAVOR,
    rag_top_k:        RAG_TOP_K,
  };
}

/**
 * Client-side RAG injection for the DIRECT (non-backend) path.
 * Call this before sending messages[] to the LLM via the ollama proxy.
 * It fetches top-k chunks synchronously (awaited) and prepends them to
 * the system message, returning the modified messages array.
 *
 * @param {Array}  messages  - the messages array about to be sent
 * @param {string} userQuery - the latest user turn text (for embedding)
 * @returns {Promise<{messages: Array, chunks: Array}>}
 */
async function injectRagContext(messages, userQuery) {
  if (RAG_MODE !== 'always') return { messages, chunks: [] };
  const sel = document.getElementById('rag-collection-select');
  const collection = sel ? sel.value : '';
  if (!collection || !userQuery) return { messages, chunks: [] };

  let chunks = [];
  const searchParams = {
    collection,
    query:        userQuery.slice(0, 2000),
    top_k:        RAG_TOP_K,
    embed_model:  RAG_EMBED_MODEL,
    embed_flavor: RAG_EMBED_FLAVOR,
    ollama_base:  OLLAMA_BASE,
    qdrant_url:   RAG_QDRANT_URL,
  };
  try {
    const data = _ragDirectMode()
      ? await _ragSearchDirect(searchParams)
      : await (async () => {
          const resp = await fetch('/api/rag/search', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(searchParams),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return resp.json();
        })();
    chunks = data.results || [];
  } catch (_) {}

  if (!chunks.length) return { messages, chunks: [] };

  const ctxBlock = _buildContextBlock(collection, chunks);
  const msgs = [...messages];

  if (msgs.length && msgs[0].role === 'system') {
    msgs[0] = { ...msgs[0], content: (msgs[0].content || '') + ctxBlock };
  } else {
    msgs.unshift({ role: 'system', content: ctxBlock.trim() });
  }
  return { messages: msgs, chunks };
}

/** Build the markdown context block injected into the system prompt. */
function _buildContextBlock(collection, chunks) {
  let block = '\n\n---\n## Relevant context retrieved from the knowledge base\n';
  block += 'Use the following excerpts to answer the user\'s question. ';
  block += 'Cite the source and section reference when referencing them.\n\n';
  chunks.forEach((c, i) => {
    const _src   = c.source || '';
    const _score = (c.score || 0).toFixed(3);
    const _body  = c.text || '';

    // Build a rich reference line depending on available metadata
    let ref = _src ? _src : '';
    if (c.page)          ref += ` · Seite ${c.page}`;
    if (c.section_title) ref += ` · ${c.section_title}`;
    if (c.json_key != null) ref += ` · element[${c.json_key}]`;
    if (c.chunk_index != null && c.json_key == null)
      ref += `, chunk ${c.chunk_index}`;

    block += `### [${i+1}]${ref ? ' ' + ref.trim() : ''} (score ${_score})\n${_body}\n\n`;
  });
  block += '---';
  return block;
}

/**
 * Render a RAG context card into the chat message list.
 * Called by backend.js when it receives a "rag-chunks" SSE event,
 * AND by chat.js after injectRagContext() on the direct path.
 *
 * @param {string} collection - collection name
 * @param {Array}  chunks     - [{text, source, chunk_index, score}, ...]
 * @param {string} chatId     - used to find the right bubble container
 */
function renderRagContextCard(collection, chunks, chatId) {
  if (!chunks || !chunks.length) return;

  const msgList = document.getElementById('chat-messages') || document.getElementById('messages-list');
  if (!msgList) return;

  // Use a turn-unique ID: combine chatId with a monotonic turn counter so each
  // message turn gets its own card. Without this, turn 2+ finds the existing
  // card by ID and silently returns, leaving a stale empty-looking card.
  const turnIdx = msgList.querySelectorAll('.rag-context-card').length;
  const cardId  = `rag-ctx-${chatId || 'c'}-${turnIdx}`;
  if (document.getElementById(cardId)) return;

  const card = document.createElement('div');
  card.id = cardId;
  card.className = 'rag-context-card';

  const chunksHtml = chunks.map((c, i) => {
    // Build metadata badge line
    let metaBadges = '';
    if (c.page)          metaBadges += `<span class="rag-point-idx">Seite ${_esc(c.page)}</span>`;
    if (c.section_title) metaBadges += `<span class="rag-point-idx">${_esc(c.section_title)}</span>`;
    if (c.json_key != null) metaBadges += `<span class="rag-point-idx">elem[${_esc(String(c.json_key))}]</span>`;
    if (!metaBadges && c.chunk_index != null)
                         metaBadges += `<span class="rag-point-idx">chunk ${c.chunk_index}</span>`;
    return `
    <div class="rag-ctx-chunk">
      <div class="rag-ctx-chunk-meta">
        <span class="rag-result-rank">#${i+1}</span>
        ${c.source ? `<span class="rag-point-source">${_esc(c.source)}</span>` : ''}
        ${metaBadges}
        <span class="rag-result-score">score ${(c.score||0).toFixed(3)}</span>
      </div>
      <div class="rag-ctx-chunk-text">${_esc((c.text||'').slice(0, 400))}${(c.text||'').length > 400 ? '…' : ''}</div>
    </div>`;
  }).join('');

  card.innerHTML = `
    <div class="rag-ctx-header">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>
      <span class="rag-ctx-label">RAG · <em>${_esc(collection)}</em></span>
      <span class="rag-ctx-count">${chunks.length} chunk${chunks.length !== 1 ? 's' : ''} retrieved</span>
      <svg class="rag-ctx-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="rag-ctx-body">${chunksHtml}</div>`;

  // Wire the toggle on the header element directly (not via inline onclick) so
  // it works correctly even after innerHTML is set.
  card.querySelector('.rag-ctx-header').addEventListener('click', () => {
    card.classList.toggle('expanded');
  });

  // Insert just before the last .msg element (the streaming assistant bubble
  // that addBubble() just created). This places the card between the user
  // bubble and the assistant reply — exactly where tool-call cards appear.
  const lastMsg = msgList.lastElementChild;
  if (lastMsg && lastMsg.classList.contains('msg')) {
    msgList.insertBefore(card, lastMsg);
  } else {
    msgList.appendChild(card);
  }
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Patch backend.js SSE handler to catch rag-chunks events ────────────────
// backend.js fires a custom DOM event or calls a handler for each SSE message.
// We hook into the global SSE message handler after it's set up.
// Strategy: wrap the existing onmessage once the page is fully loaded.
(function _hookRagSseEvent() {
  // Open a dedicated, lightweight EventSource to /api/events that listens ONLY
  // for rag-chunks events. This avoids monkey-patching window.EventSource (which
  // breaks instanceof checks in backend.js and interferes with clipboard paste
  // handlers that backend.js or fileblocks.js register via SSE callbacks).
  //
  // We derive the client_id from the same localStorage key that main.js uses
  // so the server routes our events correctly.
  let _ragEs = null;
  let _ragEsRetryTimer = null;

  function _ragEsClientId() {
    // main.js stores the CLIENT_ID in a global; fall back to localStorage.
    return (typeof CLIENT_ID !== 'undefined' && CLIENT_ID)
      ? CLIENT_ID
      : (localStorage.getItem('_jarvis_client_id') || 'anonymous');
  }

  function _openRagEventSource() {
    if (_ragEs && _ragEs.readyState !== EventSource.CLOSED) return;
    const cid = _ragEsClientId();
    _ragEs = new EventSource(`/api/events?client_id=${encodeURIComponent(cid)}`);

    _ragEs.addEventListener('message', function(raw) {
      try {
        const evt = JSON.parse(raw.data);
        if (evt && evt.type === 'rag-chunks') {
          // Small delay so the streaming assistant bubble is inserted first
          setTimeout(() => {
            renderRagContextCard(
              evt.collection || '',
              evt.chunks     || [],
              evt.chat_id    || evt.job_id || '',
            );
          }, 80);
        }
      } catch (_) {}
    });

    _ragEs.onerror = function() {
      _ragEs.close();
      // Reconnect after 3 s, backing off if the tab is hidden
      clearTimeout(_ragEsRetryTimer);
      _ragEsRetryTimer = setTimeout(_openRagEventSource, 3000);
    };
  }

  // Only open if the backend is available (checked by main.js global)
  function _tryOpen() {
    if (typeof BACKEND_AVAILABLE !== 'undefined' && BACKEND_AVAILABLE) {
      _openRagEventSource();
    } else {
      // Re-check after main.js has had time to run its health check
      setTimeout(_tryOpen, 2000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _tryOpen);
  } else {
    _tryOpen();
  }
})();

// Expose globals for chat.js / backend.js to call
window.getRagPayload        = getRagPayload;
window.injectRagContext     = injectRagContext;
window.renderRagContextCard = renderRagContextCard;

// ══ RAG-AS-A-TOOL ═════════════════════════════════════════════
// Active only when RAG_MODE === 'tool'. Instead of auto-injecting context
// every turn, the model is handed a `rag_search` tool (via ToolsEngine,
// see tools.js) and decides itself whether/when/what to query. It may
// call the tool several times in one turn — e.g. once per sub-topic —
// each call issuing its own query string and top_k.

/**
 * Returns an OpenAI-format tool schema for `rag_search`, or null when
 * tool mode is off / no collection is selected. Called by
 * ToolsEngine.buildSchemas() in tools.js.
 */
function getRagToolSchema() {
  if (RAG_MODE !== 'tool') return null;
  const sel = document.getElementById('rag-collection-select');
  const collection = sel ? sel.value : '';
  if (!collection) return null;

  // Substitute the {{rag_collection}} placeholder in the user-configurable
  // description (Settings → RAG), same idea as config.js's interpolatePrompt().
  const template = (typeof RAG_TOOL_DESCRIPTION === 'string' && RAG_TOOL_DESCRIPTION)
    ? RAG_TOOL_DESCRIPTION
    : DEFAULT_RAG_TOOL_DESCRIPTION;
  const description = template.split('{{rag_collection}}').join(collection);

  return {
    type: 'function',
    function: {
      name: 'rag_search',
      description,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'A focused search query describing exactly one topic or question to retrieve context for. ' +
              'Keep it specific and self-contained — do not bundle multiple unrelated topics into one query.'
          },
          top_k: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            description:
              'Number of chunks to retrieve, 1-20. Defaults to 5 if omitted. ' +
              'Use a higher value for broad/open-ended topics, a lower value for narrow/specific lookups.'
          }
        },
        required: ['query']
      }
    }
  };
}

/**
 * Executes a `rag_search` tool call: embeds the model-provided query,
 * retrieves top_k chunks from Qdrant, renders a context card in the chat
 * UI (so retrieval stays visible, like the "always" mode), and returns a
 * JSON string result for the tool-result message.
 *
 * Called by ToolsEngine.executeToolCall() in tools.js — direct/local path only.
 * (The backend-offloaded path executes this server-side; see server.py.)
 */
async function executeRagSearchTool(argsObj) {
  const sel = document.getElementById('rag-collection-select');
  const collection = sel ? sel.value : '';
  if (!collection) return JSON.stringify({ error: 'No RAG collection selected.' });

  const args  = argsObj || {};
  const query = String(args.query || '').slice(0, 2000);
  if (!query) return JSON.stringify({ error: 'The "query" parameter is required.' });

  let topK = parseInt(args.top_k, 10);
  if (!Number.isFinite(topK)) topK = 5;
  topK = Math.max(1, Math.min(20, topK));

  let chunks = [];
  const searchParams = {
    collection,
    query,
    top_k:        topK,
    embed_model:  RAG_EMBED_MODEL,
    embed_flavor: RAG_EMBED_FLAVOR,
    ollama_base:  OLLAMA_BASE,
    qdrant_url:   RAG_QDRANT_URL,
  };
  try {
    const data = _ragDirectMode()
      ? await _ragSearchDirect(searchParams)
      : await (async () => {
          const resp = await fetch('/api/rag/search', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(searchParams),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return resp.json();
        })();
    chunks = data.results || [];
  } catch (e) {
    return JSON.stringify({ error: `RAG search failed: ${e.message}` });
  }

  // Render a context card so this retrieval stays visible in the UI, same
  // as the "always" path. Each call gets its own card (renderRagContextCard
  // keys cards off an incrementing counter, so repeated calls in one turn
  // don't collide).
  renderRagContextCard(collection, chunks, (typeof CHAT_ID !== 'undefined' && CHAT_ID) || 'c');

  if (!chunks.length) {
    return JSON.stringify({ query, top_k: topK, results: [], note: 'No relevant chunks found for this query.' });
  }

  // Pass through the full chunk payload by default (source, score, text,
  // plus whatever extra metadata fields the collection stores — page,
  // section_title, breadcrumb, etc.), then apply the user's whitelist/
  // blacklist (Settings → RAG) if one is configured.
  return JSON.stringify({ query, top_k: topK, results: chunks.map(_filterRagFields) });
}

/**
 * Applies the user-configured field whitelist/blacklist (Settings → RAG)
 * to a single resolved chunk object before it's sent to the model. "text"
 * and "score" are always kept — dropping the chunk's actual content or its
 * relevance score would defeat the tool's purpose, so the filter only
 * applies to the rest of the metadata fields.
 */
function _filterRagFields(chunk) {
  const mode = (typeof RAG_FIELD_FILTER_MODE !== 'undefined') ? RAG_FIELD_FILTER_MODE : 'all';
  if (mode !== 'whitelist' && mode !== 'blacklist') return chunk;
  const whitelist = (typeof RAG_FIELD_WHITELIST !== 'undefined') ? RAG_FIELD_WHITELIST : [];
  const blacklist = (typeof RAG_FIELD_BLACKLIST !== 'undefined') ? RAG_FIELD_BLACKLIST : [];
  const out = {};
  for (const [k, v] of Object.entries(chunk)) {
    if (k === 'text' || k === 'score') { out[k] = v; continue; }
    if (mode === 'whitelist' && !whitelist.includes(k)) continue;
    if (mode === 'blacklist' && blacklist.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Samples a collection and returns its available payload fields (via the
 * server's /api/rag/collections/{name}/fields endpoint), for the
 * whitelist/blacklist picker in Settings → RAG.
 * Returns { sampled: number, fields: [{key, count, coverage, example}] }.
 */
async function fetchRagCollectionFields(collection) {
  if (!collection) return { sampled: 0, fields: [] };
  const url = `/api/rag/collections/${encodeURIComponent(collection)}/fields` +
    `?qdrant_url=${encodeURIComponent(RAG_QDRANT_URL)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}
window.fetchRagCollectionFields = fetchRagCollectionFields;

/**
 * Connection details for the rag_search tool when the turn is handed off
 * to the backend (server.py executes the tool call itself, since the job
 * may keep running after the tab closes). Returns {} when tool mode is off.
 */
function getRagToolBackendPayload() {
  if (RAG_MODE !== 'tool') return {};
  const sel = document.getElementById('rag-collection-select');
  const collection = sel ? sel.value : '';
  if (!collection) return {};
  return {
    rag_tool_collection:   collection,
    rag_tool_qdrant_url:   RAG_QDRANT_URL,
    rag_tool_embed_model:  RAG_EMBED_MODEL,
    rag_tool_embed_flavor: RAG_EMBED_FLAVOR,
    rag_tool_field_filter_mode: RAG_FIELD_FILTER_MODE,
    rag_tool_field_whitelist:   RAG_FIELD_WHITELIST,
    rag_tool_field_blacklist:   RAG_FIELD_BLACKLIST,
  };
}

window.getRagMode               = getRagMode;
window.setRagMode               = setRagMode;
window.getRagToolSchema         = getRagToolSchema;
window.executeRagSearchTool     = executeRagSearchTool;
window.getRagToolBackendPayload = getRagToolBackendPayload;

// ── Wrap generateChatBackend to inject RAG payload ────────────────────────
// backend.js defines generateChatBackend in global scope AFTER rag.js loads,
// so we defer the wrap until DOMContentLoaded when all scripts have run.
// The wrapper adds rag_collection + rag_* fields to the POST body by passing
// them via an extra "extraBody" key that backend.js merges into its fetch call.
//
// Because we cannot edit backend.js, we patch at the fetch level instead:
// RAG fields for the backend path are injected directly in chat.js at the
// generateChatBackend() call site (see the getRagPayload() call there).
// A window.fetch monkey-patch was previously used here but it made every
// fetch() call on the page async, breaking browser clipboard/paste security
// gesture chains on all browsers. Removed.
