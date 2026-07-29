// ══ SETTINGS.JS ══════════════════════════════════════════════
// Settings modal: DOM refs, open/close/save wiring, inline
// connection check, and JSON settings export / import.
//
// Depends on: config.js  (all settings variables)
//             api.js     (API.checkUrl)
//             main.js    (applyTheme, applyFontSize, applyAccent,
//                         setImgApiMode, checkOllama, listImgModels,
//                         statusDot, statusText, thinkToggle,
//                         RUNTIME_OPTIONS, URL_OVERRIDES)
//
// Load order in index.html:  … → main.js → search.js → settings.js → …

// ── Chat column width ─────────────────────────────────────────
// Applies --chat-width on :root so the CSS clamps the message/input
// columns on wide screens. Also updates the label next to the slider.
function applyChatWidth(px) {
  CHAT_WIDTH = px || DEFAULT_CHAT_WIDTH;
  document.documentElement.style.setProperty('--chat-width', CHAT_WIDTH + 'px');
  const lbl = document.getElementById('chat-width-label');
  if (lbl) lbl.textContent = CHAT_WIDTH + ' px';
  const slider = document.getElementById('set-chat-width');
  if (slider && parseInt(slider.value) !== CHAT_WIDTH) slider.value = CHAT_WIDTH;
}

// ── Settings modal DOM refs ───────────────────────────────────
const settingsModal      = document.getElementById('settings-modal');
const setApiUrl          = document.getElementById('set-api-url');
const setImgApiUrl       = document.getElementById('set-img-api-url');
const setImgApiFlavor    = document.getElementById('set-img-api-flavor');
const setTemp            = document.getElementById('set-temp');
const setCtx             = document.getElementById('set-ctx');
const setTopP            = document.getElementById('set-top-p');
const setTopK            = document.getElementById('set-top-k');
const setRepPen          = document.getElementById('set-rep-pen');
const setNumBatch        = document.getElementById('set-num-batch');
const setCorrectorSystem = document.getElementById('set-corrector-system');
// Chat system prompts are managed dynamically — no single textarea ref needed.
//const setBraveApiKey   = document.getElementById('set-brave-api-key');
const setBraveResults    = document.getElementById('set-brave-results');
const setBraveProxy      = document.getElementById('set-brave-proxy');

// ── Open / close ──────────────────────────────────────────────
document.getElementById('settings-open-btn').onclick = () => {
  settingsModal.classList.remove('hidden');
  // Populate every field from current in-memory values (which mirror localStorage).
  // This also calls applyTheme / applyFontSize / applyAccent internally.
  loadSettingsUI();
  const _ragDescEl = document.getElementById('set-rag-tool-description');
  if (_ragDescEl) _ragDescEl.value = RAG_TOOL_DESCRIPTION;
  document.getElementById('reset-rag-tool-description-btn')?.addEventListener('click', () => {
    if (_ragDescEl) _ragDescEl.value = DEFAULT_RAG_TOOL_DESCRIPTION;
  });
  // Refresh the collection lists (including the field-picker select) and
  // re-render the field chips against the current filter mode.
  if (typeof refreshRagCollections === 'function') refreshRagCollections();
  if (typeof refreshMemoryEntries === 'function') refreshMemoryEntries();
  if (typeof loadSettingsEmbedModels === 'function') loadSettingsEmbedModels();
  _renderRagFieldChips(_ragFieldChipsCache);
  document.getElementById('set-font-size').addEventListener('input', e => applyFontSize(parseInt(e.target.value)));
  document.getElementById('set-accent-color').addEventListener('input', e => applyAccent(e.target.value));
  document.getElementById('reset-accent-btn').onclick = () => applyAccent(DEFAULT_ACCENT);
  document.getElementById('set-chat-width').addEventListener('input', e => applyChatWidth(parseInt(e.target.value)));
};
document.getElementById('settings-close-btn').onclick = () => settingsModal.classList.add('hidden');

// ── RAG result field whitelist/blacklist picker ────────────────
// Lets the user fetch the actual payload keys present in a collection
// (sampled server-side) and toggle which ones rag_search includes in its
// results. "text" and "score" are always sent regardless of filter.
let _ragFieldChipsCache = []; // last fetched: [{key, count, coverage, example}]

function setRagFieldFilterMode(mode) {
  if (!['all', 'whitelist', 'blacklist'].includes(mode)) return;
  RAG_FIELD_FILTER_MODE = mode;
  localStorage.setItem('rag_field_filter_mode', mode);
  document.querySelectorAll('#rag-field-filter-mode-group .toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filterMode === mode);
  });
  _renderRagFieldChips(_ragFieldChipsCache);
}

function _ragFieldIncluded(key) {
  if (RAG_FIELD_FILTER_MODE === 'whitelist') return RAG_FIELD_WHITELIST.includes(key);
  if (RAG_FIELD_FILTER_MODE === 'blacklist') return !RAG_FIELD_BLACKLIST.includes(key);
  return true; // 'all' — nothing filtered
}

function _toggleRagField(key) {
  if (RAG_FIELD_FILTER_MODE === 'whitelist') {
    const i = RAG_FIELD_WHITELIST.indexOf(key);
    if (i === -1) RAG_FIELD_WHITELIST.push(key); else RAG_FIELD_WHITELIST.splice(i, 1);
    localStorage.setItem('rag_field_whitelist', JSON.stringify(RAG_FIELD_WHITELIST));
  } else if (RAG_FIELD_FILTER_MODE === 'blacklist') {
    const i = RAG_FIELD_BLACKLIST.indexOf(key);
    if (i === -1) RAG_FIELD_BLACKLIST.push(key); else RAG_FIELD_BLACKLIST.splice(i, 1);
    localStorage.setItem('rag_field_blacklist', JSON.stringify(RAG_FIELD_BLACKLIST));
  }
  // mode 'all' — nothing to toggle, nothing is filtered
}

function _renderRagFieldChips(fields) {
  const wrap = document.getElementById('rag-field-chips');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!fields || !fields.length) {
    wrap.innerHTML = '<span style="font-size:11px;color:var(--text-dim);">No fields fetched yet — pick a collection and click fetch.</span>';
    return;
  }
  const interactive = RAG_FIELD_FILTER_MODE !== 'all';
  for (const f of fields) {
    const forced   = (f.key === 'text' || f.key === 'score');
    const included = forced ? true : _ragFieldIncluded(f.key);
    const chip = document.createElement('label');
    chip.style.cssText =
      'display:flex;align-items:center;gap:4px;font-size:0.76em;' +
      'padding:2px 8px;border-radius:10px;border:1px solid var(--border);' +
      `cursor:${(forced || !interactive) ? 'default' : 'pointer'};` +
      `opacity:${included ? '1' : '0.45'};` +
      `background:${included ? 'var(--bg2)' : 'transparent'};color:var(--text2);`;
    chip.title = `present in ~${Math.round((f.coverage || 0) * 100)}% of sampled points` +
      (f.example != null ? ` — e.g. ${JSON.stringify(f.example)}` : '');

    if (!forced && interactive) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = included;
      cb.onchange = () => { _toggleRagField(f.key); _renderRagFieldChips(fields); };
      chip.appendChild(cb);
    }
    const label = document.createElement('span');
    label.textContent = f.key + (forced ? ' 🔒' : '');
    chip.appendChild(label);
    wrap.appendChild(chip);
  }
}

document.querySelectorAll('#rag-field-filter-mode-group .toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => setRagFieldFilterMode(btn.dataset.filterMode));
});
setRagFieldFilterMode(RAG_FIELD_FILTER_MODE);

document.getElementById('rag-fetch-fields-btn')?.addEventListener('click', async () => {
  const sel        = document.getElementById('set-rag-field-collection');
  const collection = sel ? sel.value : '';
  const statusEl   = document.getElementById('rag-field-fetch-status');
  if (!collection) {
    if (statusEl) statusEl.textContent = 'Pick a collection first.';
    return;
  }
  if (statusEl) statusEl.textContent = 'Sampling…';
  try {
    const data = await fetchRagCollectionFields(collection);
    _ragFieldChipsCache = data.fields || [];
    if (statusEl) statusEl.textContent = `Sampled ${data.sampled} point(s) — ${_ragFieldChipsCache.length} field(s) found.`;
    _renderRagFieldChips(_ragFieldChipsCache);
  } catch (e) {
    if (statusEl) statusEl.textContent = `Fetch failed: ${e.message}`;
  }
});

// ── Section navigation (left sidebar) ────────────────────────
(function initSettingsNav() {
  const navItems = document.querySelectorAll('.settings-nav-item');
  const sections = document.querySelectorAll('.settings-section');
  navItems.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.section;
      navItems.forEach(b => b.classList.toggle('active', b === btn));
      sections.forEach(s => s.classList.toggle('active', s.id === 'section-' + target));
    });
  });
})();

// ── Inline connection check (does NOT save OLLAMA_BASE) ───────
// Races direct vs backend-proxy (see ollama.js's _fetchJson) instead of
// trying them sequentially. Built from plain Promise/fetch only (no
// Promise.any/AggregateError) to rule out any combinator-API quirk.
async function checkUrlConnection(url, flavor) {
  statusDot.className    = 'status-dot';
  statusText.textContent = 'Checking\u2026';
  const checkBtn = document.getElementById('settings-check-btn');
  if (checkBtn) checkBtn.disabled = true;
  const base     = url.replace(/\/$/, '');
  const endpoint = API.checkUrl(base, flavor);
  const path     = endpoint.startsWith(base) ? endpoint.slice(base.length) : endpoint;

  let pending = 2;
  let directErr = null;
  let settled = false;

  const succeed = (via) => {
    if (settled) return;
    settled = true;
    statusDot.className    = 'status-dot online';
    statusText.textContent = via === 'direct' ? 'Reachable' : 'Reachable via backend \u2014 not directly from this browser';
    if (checkBtn) checkBtn.disabled = false;
  };
  const fail = (err, isDirect) => {
    if (isDirect) directErr = err;
    pending--;
    if (pending === 0 && !settled) {
      statusDot.className    = 'status-dot error';
      statusText.textContent = `Not reachable\u200B: ${(directErr || err).message || url}`;
      if (checkBtn) checkBtn.disabled = false;
    }
  };

  // Timeouts tightened to match ollama.js's _fetchJson (2500/4500ms) — see
  // that file's comment for why the old 4000/6000ms ceilings made this
  // check feel sluggish on any flaky leg even when the other one was fine.
  fetch(endpoint, { signal: AbortSignal.timeout(2500) })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(() => succeed('direct'))
    .catch(err => fail(err, true));

  fetch(`/api/ollama-proxy${path}?base=${encodeURIComponent(base)}`, { signal: AbortSignal.timeout(4500) })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(() => succeed('proxy'))
    .catch(err => fail(err, false));
}

document.getElementById('settings-check-btn').addEventListener('click', () => {
  const flavor = document.getElementById('set-api-flavor')?.value || API_FLAVOR;
  checkUrlConnection(setApiUrl.value.trim() || OLLAMA_BASE, flavor);
});

setApiUrl.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const flavor = document.getElementById('set-api-flavor')?.value || API_FLAVOR;
    checkUrlConnection(setApiUrl.value.trim() || OLLAMA_BASE, flavor);
  }
});

// ── Save ──────────────────────────────────────────────────────
document.getElementById('settings-save-btn').onclick = () => {
  OLLAMA_BASE = setApiUrl.value.trim();
  const flavorSel = document.getElementById('set-api-flavor');
  if (flavorSel) API_FLAVOR = flavorSel.value;
  ADV_OPTIONS = {
    temperature:    parseFloat(setTemp.value),
    num_ctx:        parseInt(setCtx.value),
    top_p:          parseFloat(setTopP.value),
    top_k:          setTopK && setTopK.value.trim() !== '' ? parseInt(setTopK.value) : null,
    repeat_penalty: parseFloat(setRepPen.value),
    num_batch:      setNumBatch.value.trim() !== '' ? parseInt(setNumBatch.value) : null
  };
  // Strip null / NaN entries — omitted keys let the model use its own defaults.
  Object.keys(ADV_OPTIONS).forEach(k => {
    const v = ADV_OPTIONS[k];
    if (v === null || (typeof v === 'number' && isNaN(v))) delete ADV_OPTIONS[k];
  });
  CORRECTOR_SYSTEM = setCorrectorSystem.value;
  // CHAT_PROMPTS and ACTIVE_PROMPT_ID are saved immediately on every edit
  // inside _initChatPromptsSection — nothing extra needed here.

  // Brave Search — API key is injected by Zoraxy, not stored in browser
  BRAVE_PROXY_URL = setBraveProxy.value.trim();
  BRAVE_RESULTS   = parseInt(setBraveResults.value) || 5;

  localStorage.setItem('ollama_base',      OLLAMA_BASE);
  localStorage.setItem('api_flavor',       API_FLAVOR);
  localStorage.setItem('ollama_options',   JSON.stringify(ADV_OPTIONS));
  localStorage.setItem('corrector_system', CORRECTOR_SYSTEM);
  // chat_prompts + active_prompt_id are written immediately on change
  localStorage.setItem('brave_proxy_url',  BRAVE_PROXY_URL);
  localStorage.setItem('brave_results',    BRAVE_RESULTS);
  localStorage.removeItem('brave_api_key');

  // Appearance
  localStorage.setItem('app_theme',     APP_THEME);
  localStorage.setItem('app_font_size', APP_FONT_SIZE);
  localStorage.setItem('app_accent',    APP_ACCENT);
  SHOW_STATS = document.getElementById('set-show-stats')?.checked ?? true;
  localStorage.setItem('show_stats', SHOW_STATS);
  const _chatWidthEl = document.getElementById('set-chat-width');
  if (_chatWidthEl) {
    CHAT_WIDTH = parseInt(_chatWidthEl.value) || DEFAULT_CHAT_WIDTH;
    localStorage.setItem('chat_width', CHAT_WIDTH);
    applyChatWidth(CHAT_WIDTH);
  }

  // Image API
  IMG_API_BASE = setImgApiUrl ? setImgApiUrl.value.trim() : '';
  localStorage.setItem('img_api_base', IMG_API_BASE);
  IMG_API_FLAVOR = setImgApiFlavor ? setImgApiFlavor.value : IMG_API_FLAVOR;
  localStorage.setItem('img_api_flavor', IMG_API_FLAVOR);
  IMG_API_MODE = IMG_API_FLAVOR === 'ollama' ? 'native' : 'openai';
  localStorage.setItem('img_api_mode', IMG_API_MODE);
  setImgApiMode(IMG_API_MODE);

  // Server Client ID override
  const _setClientIdEl = document.getElementById('set-client-id-override');
  BACKEND_CLIENT_ID_OVERRIDE = _setClientIdEl ? _setClientIdEl.value.trim() : '';
  if (BACKEND_CLIENT_ID_OVERRIDE) {
    localStorage.setItem('backend_client_id_override', BACKEND_CLIENT_ID_OVERRIDE);
  } else {
    localStorage.removeItem('backend_client_id_override');
  }

  // RAG / Qdrant
  const _setQdrantUrl = document.getElementById('set-qdrant-url');
  if (_setQdrantUrl) {
    RAG_QDRANT_URL = _setQdrantUrl.value.trim() || RAG_QDRANT_URL;
    localStorage.setItem('rag_qdrant_url', RAG_QDRANT_URL);
  }
  const _setRagEmbedModel = document.getElementById('set-rag-embed-model');
  if (_setRagEmbedModel) {
    // Works for both <select> and legacy <input type="text">
    const _emVal = (_setRagEmbedModel.value || '').trim();
    if (_emVal) {
      RAG_EMBED_MODEL = _emVal;
      localStorage.setItem('rag_embed_model', RAG_EMBED_MODEL);
    }
  }
  const _setRagEmbedFlavor = document.getElementById('set-rag-embed-flavor');
  if (_setRagEmbedFlavor) {
    RAG_EMBED_FLAVOR = _setRagEmbedFlavor.value;
    localStorage.setItem('rag_embed_flavor', RAG_EMBED_FLAVOR);
  }
  const _setRagTopK = document.getElementById('set-rag-top-k');
  if (_setRagTopK) {
    RAG_TOP_K = parseInt(_setRagTopK.value) || 5;
    localStorage.setItem('rag_top_k', RAG_TOP_K);
  }
  const _setRagToolDesc = document.getElementById('set-rag-tool-description');
  if (_setRagToolDesc) {
    RAG_TOOL_DESCRIPTION = _setRagToolDesc.value.trim() || DEFAULT_RAG_TOOL_DESCRIPTION;
    localStorage.setItem('rag_tool_description', RAG_TOOL_DESCRIPTION);
  }
  // Refresh RAG collections with updated URL
  if (typeof refreshRagCollections === 'function') refreshRagCollections();

  // Re-apply URL overrides on top of newly saved settings
  RUNTIME_OPTIONS = { ...ADV_OPTIONS, ...URL_OVERRIDES };

  settingsModal.classList.add('hidden');
  checkOllama();
  listImgModels();
};

// ── Settings Export / Import ──────────────────────────────────
function exportSettings() {
  const snapshot = {
    _version: 2,
    ollama_base:      OLLAMA_BASE,
    api_flavor:       API_FLAVOR,
    ollama_options:   ADV_OPTIONS,
    corrector_system: CORRECTOR_SYSTEM,
    chat_prompts:     CHAT_PROMPTS,
    active_prompt_id: ACTIVE_PROMPT_ID,
    brave_proxy_url:  BRAVE_PROXY_URL,
    brave_results:    BRAVE_RESULTS,
    app_theme:        APP_THEME,
    app_font_size:    APP_FONT_SIZE,
    app_accent:       APP_ACCENT,
    chat_width:       CHAT_WIDTH,
    img_api_mode:     IMG_API_MODE,
    img_api_base:     IMG_API_BASE,
    img_api_flavor:   IMG_API_FLAVOR,
    backend_client_id_override: BACKEND_CLIENT_ID_OVERRIDE,
    ollama_think:     thinkToggle.checked,
    show_stats:       SHOW_STATS,
    tools_enabled:    TOOLS_ENABLED,
    max_tool_rounds:  MAX_TOOL_ROUNDS,
    tools_config:     TOOLS_CONFIG,
    builtin_tools:    BUILTIN_TOOLS,
    img_tool_description:    IMG_TOOL_DESCRIPTION,
    img_tool_default_width:  IMG_TOOL_DEFAULT_WIDTH,
    img_tool_default_height: IMG_TOOL_DEFAULT_HEIGHT,
    rag_qdrant_url:   RAG_QDRANT_URL,
    rag_embed_model:  RAG_EMBED_MODEL,
    rag_embed_flavor: RAG_EMBED_FLAVOR,
    rag_top_k:        RAG_TOP_K,
    rag_tool_description: RAG_TOOL_DESCRIPTION,
    rag_field_filter_mode: RAG_FIELD_FILTER_MODE,
    rag_field_whitelist:   RAG_FIELD_WHITELIST,
    rag_field_blacklist:   RAG_FIELD_BLACKLIST,
    memory_enabled:   MEMORY_ENABLED,
    memory_top_k:     MEMORY_TOP_K,
    memory_min_score: MEMORY_MIN_SCORE,
  };
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'jarvis-settings.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importSettings() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const s = JSON.parse(text);

      if (s.ollama_base !== undefined) {
        OLLAMA_BASE = s.ollama_base;
        localStorage.setItem('ollama_base', OLLAMA_BASE);
        setApiUrl.value = OLLAMA_BASE;
      }
      if (s.api_flavor !== undefined) {
        API_FLAVOR = s.api_flavor;
        localStorage.setItem('api_flavor', API_FLAVOR);
        const flavorSel = document.getElementById('set-api-flavor');
        if (flavorSel) flavorSel.value = API_FLAVOR;
      }
      if (s.ollama_options !== undefined) {
        ADV_OPTIONS = { ...ADV_OPTIONS, ...s.ollama_options };
        localStorage.setItem('ollama_options', JSON.stringify(ADV_OPTIONS));
        setTemp.value     = ADV_OPTIONS.temperature;
        setCtx.value      = ADV_OPTIONS.num_ctx;
        setTopP.value     = ADV_OPTIONS.top_p;
        if (setTopK) setTopK.value = (ADV_OPTIONS.top_k != null) ? ADV_OPTIONS.top_k : '';
        setRepPen.value   = ADV_OPTIONS.repeat_penalty;
        setNumBatch.value = (ADV_OPTIONS.num_batch != null) ? ADV_OPTIONS.num_batch : '';
      }
      if (s.corrector_system !== undefined) {
        CORRECTOR_SYSTEM = s.corrector_system;
        localStorage.setItem('corrector_system', CORRECTOR_SYSTEM);
        setCorrectorSystem.value = CORRECTOR_SYSTEM;
      }
      // Import multi-prompt list (v2+); also migrate v1 single chat_system
      if (s.chat_prompts !== undefined && Array.isArray(s.chat_prompts)) {
        CHAT_PROMPTS = s.chat_prompts;
        localStorage.setItem('chat_prompts', JSON.stringify(CHAT_PROMPTS));
      } else if (s.chat_system !== undefined) {
        // v1 migration: wrap the single string into the first prompt
        const migId = CHAT_PROMPTS[0]?.id || _DEFAULT_PROMPT_ID;
        CHAT_PROMPTS = [{ id: migId, name: 'Default', content: s.chat_system }];
        localStorage.setItem('chat_prompts', JSON.stringify(CHAT_PROMPTS));
      }
      if (s.active_prompt_id !== undefined) {
        ACTIVE_PROMPT_ID = s.active_prompt_id;
        localStorage.setItem('active_prompt_id', ACTIVE_PROMPT_ID);
      }
      if (typeof renderChatPromptsUI === 'function') renderChatPromptsUI();
      if (s.brave_proxy_url !== undefined) {
        BRAVE_PROXY_URL = s.brave_proxy_url;
        localStorage.setItem('brave_proxy_url', BRAVE_PROXY_URL);
        setBraveProxy.value = BRAVE_PROXY_URL;
      }
      if (s.brave_results !== undefined) {
        BRAVE_RESULTS = s.brave_results;
        localStorage.setItem('brave_results', BRAVE_RESULTS);
        setBraveResults.value = BRAVE_RESULTS;
      }
      if (s.app_theme !== undefined) { localStorage.setItem('app_theme', s.app_theme); applyTheme(s.app_theme); }
      if (s.app_font_size !== undefined) { localStorage.setItem('app_font_size', s.app_font_size); applyFontSize(s.app_font_size); }
      if (s.app_accent !== undefined) { localStorage.setItem('app_accent', s.app_accent); applyAccent(s.app_accent); }
      if (s.chat_width !== undefined) {
        CHAT_WIDTH = parseInt(s.chat_width) || DEFAULT_CHAT_WIDTH;
        localStorage.setItem('chat_width', CHAT_WIDTH);
        applyChatWidth(CHAT_WIDTH);
      }
      if (s.img_api_mode !== undefined) {
        IMG_API_MODE = s.img_api_mode;
        localStorage.setItem('img_api_mode', IMG_API_MODE);
        setImgApiMode(IMG_API_MODE);
      }
      if (s.img_api_base !== undefined) {
        IMG_API_BASE = s.img_api_base;
        localStorage.setItem('img_api_base', IMG_API_BASE);
        if (setImgApiUrl) setImgApiUrl.value = IMG_API_BASE;
      }
      if (s.img_api_flavor !== undefined) {
        IMG_API_FLAVOR = s.img_api_flavor;
        localStorage.setItem('img_api_flavor', IMG_API_FLAVOR);
        if (setImgApiFlavor) setImgApiFlavor.value = IMG_API_FLAVOR;
      }
      if (s.backend_client_id_override !== undefined) {
        BACKEND_CLIENT_ID_OVERRIDE = s.backend_client_id_override || '';
        if (BACKEND_CLIENT_ID_OVERRIDE) {
          localStorage.setItem('backend_client_id_override', BACKEND_CLIENT_ID_OVERRIDE);
        } else {
          localStorage.removeItem('backend_client_id_override');
        }
        const _el = document.getElementById('set-client-id-override');
        if (_el) {
          _el.value       = BACKEND_CLIENT_ID_OVERRIDE;
          _el.placeholder = CLIENT_ID;
        }
      }
      if (s.ollama_think !== undefined) {
        thinkToggle.checked = s.ollama_think;
        localStorage.setItem('ollama_think', s.ollama_think);
      }
      if (s.show_stats !== undefined) {
        SHOW_STATS = s.show_stats;
        localStorage.setItem('show_stats', SHOW_STATS);
        const el = document.getElementById('set-show-stats');
        if (el) el.checked = SHOW_STATS;
      }
      if (s.tools_enabled !== undefined) {
        TOOLS_ENABLED = !!s.tools_enabled;
        localStorage.setItem('tools_enabled', TOOLS_ENABLED);
      }
      if (s.max_tool_rounds !== undefined) {
        const n = parseInt(s.max_tool_rounds);
        MAX_TOOL_ROUNDS = (Number.isFinite(n) && n >= 0) ? n : 5;
        localStorage.setItem('max_tool_rounds', MAX_TOOL_ROUNDS);
        const el = document.getElementById('set-max-tool-rounds');
        if (el) el.value = MAX_TOOL_ROUNDS;
      }
      if (s.tools_config !== undefined) {
        TOOLS_CONFIG = Array.isArray(s.tools_config) ? s.tools_config : [];
        localStorage.setItem('tools_config', JSON.stringify(TOOLS_CONFIG));
      }
      if (s.builtin_tools !== undefined && typeof s.builtin_tools === 'object') {
        BUILTIN_TOOLS = { ...BUILTIN_TOOLS, ...s.builtin_tools };
        localStorage.setItem('builtin_tools', JSON.stringify(BUILTIN_TOOLS));
      }
      if (s.img_tool_description !== undefined) {
        IMG_TOOL_DESCRIPTION = s.img_tool_description || DEFAULT_IMG_TOOL_DESCRIPTION;
        localStorage.setItem('img_tool_description', IMG_TOOL_DESCRIPTION);
      }
      if (s.img_tool_default_width !== undefined) {
        IMG_TOOL_DEFAULT_WIDTH = parseInt(s.img_tool_default_width) || 512;
        localStorage.setItem('img_tool_default_width', IMG_TOOL_DEFAULT_WIDTH);
      }
      if (s.img_tool_default_height !== undefined) {
        IMG_TOOL_DEFAULT_HEIGHT = parseInt(s.img_tool_default_height) || 512;
        localStorage.setItem('img_tool_default_height', IMG_TOOL_DEFAULT_HEIGHT);
      }
      if (typeof renderBuiltinList === 'function') renderBuiltinList();
      if (s.rag_qdrant_url !== undefined) {
        RAG_QDRANT_URL = s.rag_qdrant_url;
        localStorage.setItem('rag_qdrant_url', RAG_QDRANT_URL);
        const el = document.getElementById('set-qdrant-url');
        if (el) el.value = RAG_QDRANT_URL;
      }
      if (s.rag_embed_model !== undefined) {
        RAG_EMBED_MODEL = s.rag_embed_model;
        localStorage.setItem('rag_embed_model', RAG_EMBED_MODEL);
        const el = document.getElementById('set-rag-embed-model');
        if (el) el.value = RAG_EMBED_MODEL;
      }
      if (s.rag_embed_flavor !== undefined) {
        RAG_EMBED_FLAVOR = s.rag_embed_flavor;
        localStorage.setItem('rag_embed_flavor', RAG_EMBED_FLAVOR);
        const el = document.getElementById('set-rag-embed-flavor');
        if (el) el.value = RAG_EMBED_FLAVOR;
      }
      if (s.rag_top_k !== undefined) {
        RAG_TOP_K = parseInt(s.rag_top_k) || 5;
        localStorage.setItem('rag_top_k', RAG_TOP_K);
        const el = document.getElementById('set-rag-top-k');
        if (el) el.value = RAG_TOP_K;
      }
      if (s.rag_tool_description !== undefined) {
        RAG_TOOL_DESCRIPTION = s.rag_tool_description || DEFAULT_RAG_TOOL_DESCRIPTION;
        localStorage.setItem('rag_tool_description', RAG_TOOL_DESCRIPTION);
        const el = document.getElementById('set-rag-tool-description');
        if (el) el.value = RAG_TOOL_DESCRIPTION;
      }
      if (s.rag_field_filter_mode !== undefined) {
        setRagFieldFilterMode(s.rag_field_filter_mode);
      }
      if (Array.isArray(s.rag_field_whitelist)) {
        RAG_FIELD_WHITELIST = s.rag_field_whitelist;
        localStorage.setItem('rag_field_whitelist', JSON.stringify(RAG_FIELD_WHITELIST));
      }
      if (Array.isArray(s.rag_field_blacklist)) {
        RAG_FIELD_BLACKLIST = s.rag_field_blacklist;
        localStorage.setItem('rag_field_blacklist', JSON.stringify(RAG_FIELD_BLACKLIST));
      }
      _renderRagFieldChips(_ragFieldChipsCache);

      if (s.memory_enabled !== undefined) {
        MEMORY_ENABLED = !!s.memory_enabled;
        localStorage.setItem('memory_enabled', MEMORY_ENABLED);
        const el = document.getElementById('set-memory-enabled');
        if (el) el.checked = MEMORY_ENABLED;
        if (typeof _syncMemoryToggleUI === 'function') _syncMemoryToggleUI(MEMORY_ENABLED);
      }
      if (s.memory_top_k !== undefined) {
        MEMORY_TOP_K = parseInt(s.memory_top_k) || 5;
        localStorage.setItem('memory_top_k', MEMORY_TOP_K);
        const el = document.getElementById('set-memory-top-k');
        if (el) el.value = MEMORY_TOP_K;
      }
      if (s.memory_min_score !== undefined) {
        MEMORY_MIN_SCORE = parseFloat(s.memory_min_score);
        if (!Number.isFinite(MEMORY_MIN_SCORE)) MEMORY_MIN_SCORE = 0.55;
        localStorage.setItem('memory_min_score', MEMORY_MIN_SCORE);
        const el = document.getElementById('set-memory-min-score');
        if (el) el.value = MEMORY_MIN_SCORE;
        const lbl = document.getElementById('memory-min-score-label');
        if (lbl) lbl.textContent = MEMORY_MIN_SCORE.toFixed(2);
      }
      if (typeof refreshMemoryEntries === 'function') refreshMemoryEntries();

      // Re-render the tools section for any of the above changes.
      // The 'tools:refresh' listener lives inside _initToolsSection so it
      // has direct access to the render functions without window pollution.
      settingsModal.dispatchEvent(new CustomEvent('tools:refresh'));

      RUNTIME_OPTIONS = { ...ADV_OPTIONS, ...URL_OVERRIDES };
      listImgModels();

      const btn = document.getElementById('settings-import-btn');
      const orig = btn.textContent;
      btn.textContent = '✓ imported';
      btn.style.color = 'var(--green)';
      setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 2000);
    } catch (err) {
      alert('Failed to import settings: ' + err.message);
    }
  };
  input.click();
}

document.getElementById('settings-export-btn').addEventListener('click', exportSettings);
document.getElementById('settings-import-btn').addEventListener('click', importSettings);

// ══ CHAT PROMPTS SECTION ═════════════════════════════════════
// Manages the list of named chat system prompts in Settings > Prompts.
// Also keeps the model-bar #sysprompt-select in sync.
// Exposed as window.renderChatPromptsUI so main.js / importSettings can call it.

(function _initChatPromptsSection() {

  const container = document.getElementById('section-chat-prompts');
  if (!container) return;

  // ── Shared style consts ────────────────────────────────────
  const INPUT_STYLE =
    'background:var(--bg3,var(--bg2));color:var(--text);border:1px solid var(--border);' +
    'border-radius:4px;padding:4px 6px;font-size:0.85em;width:100%;box-sizing:border-box;';
  // Buttons now use the .settings-row-btn CSS class (defined in styles.css)
  // BTN_STYLE kept as empty string for any legacy inline usage
  const BTN_STYLE = '';

  // ── Drag-and-drop helper (shared) ─────────────────────────
  function _makeDraggable(listEl, getArray, setArray, onDrop) {
    let dragSrcId = null;
    listEl.querySelectorAll('[data-drag-id]').forEach(row => {
      const handle = row.querySelector('.settings-drag-handle');
      if (!handle) return;
      handle.addEventListener('mousedown', () => { row.draggable = true; });
      row.addEventListener('dragstart', e => {
        dragSrcId = row.dataset.dragId;
        row.classList.add('drag-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        row.draggable = false;
        row.classList.remove('drag-dragging');
        listEl.querySelectorAll('[data-drag-id]').forEach(r => r.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        listEl.querySelectorAll('[data-drag-id]').forEach(r => r.classList.remove('drag-over'));
        if (row.dataset.dragId !== dragSrcId) row.classList.add('drag-over');
      });
      row.addEventListener('drop', e => {
        e.preventDefault();
        const targetId = row.dataset.dragId;
        if (!dragSrcId || dragSrcId === targetId) return;
        const arr = getArray();
        const fromIdx = arr.findIndex(x => (x.id || x) === dragSrcId);
        const toIdx   = arr.findIndex(x => (x.id || x) === targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        arr.splice(toIdx, 0, arr.splice(fromIdx, 1)[0]);
        setArray(arr);
        onDrop();
      });
    });
  }

  function _id() { return 'p_' + Math.random().toString(36).slice(2, 10); }

  function _savePrompts() {
    localStorage.setItem('chat_prompts',     JSON.stringify(CHAT_PROMPTS));
    localStorage.setItem('active_prompt_id', ACTIVE_PROMPT_ID);
    // Only sync the select's option labels/list (not its selected value)
    // when names change. Full sync happens via renderChatPromptsUI.
    _syncModelBarSelect();
  }

  // ── Model-bar select sync ──────────────────────────────────
  // ONE-WAY: ACTIVE_PROMPT_ID → sel.value (never the other way).
  // The <select> is a mirror; ACTIVE_PROMPT_ID is the source of truth.
  function _syncModelBarSelect() {
    const sel = document.getElementById('sysprompt-select');
    if (!sel) return;
    // Rebuild options list
    sel.innerHTML = '';
    for (const p of CHAT_PROMPTS) {
      const opt = document.createElement('option');
      opt.value       = p.id;
      opt.textContent = p.name || '(unnamed)';
      sel.appendChild(opt);
    }
    // If ACTIVE_PROMPT_ID no longer exists (e.g. after delete), fall back to first
    if (!CHAT_PROMPTS.find(p => p.id === ACTIVE_PROMPT_ID)) {
      ACTIVE_PROMPT_ID = CHAT_PROMPTS[0]?.id ?? '';
      localStorage.setItem('active_prompt_id', ACTIVE_PROMPT_ID);
    }
    sel.value = ACTIVE_PROMPT_ID;
  }

  // Wire model-bar select → update ACTIVE_PROMPT_ID live
  const modelBarSel = document.getElementById('sysprompt-select');
  if (modelBarSel) {
    modelBarSel.addEventListener('change', () => {
      ACTIVE_PROMPT_ID = modelBarSel.value;
      localStorage.setItem('active_prompt_id', ACTIVE_PROMPT_ID);
      // Refresh radio buttons in the settings list if it is open
      _refreshRadios();
    });
  }

  // Light-weight radio refresh — avoids full renderList() when only
  // the active selection changed (e.g. via the model-bar dropdown).
  function _refreshRadios() {
    container.querySelectorAll('input[name="active-prompt"]').forEach(r => {
      r.checked = (r.closest('[data-pid]')?.dataset.pid === ACTIVE_PROMPT_ID);
    });
  }

  // ── Per-prompt row state ───────────────────────────────────
  // Track which prompt's editor is open (one open at a time)
  let _editingId = null;

  // ── Main render ────────────────────────────────────────────
  function renderList() {
    container.innerHTML = '';

    // Section header
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;' +
      'margin:14px 0 8px;border-top:1px solid var(--border);padding-top:14px;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;font-size:0.97em;';
    title.textContent = 'Chat System Prompts';
    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add prompt';
    addBtn.className = 'settings-row-btn';
    addBtn.onclick = () => {
      const newPrompt = { id: _id(), name: 'New prompt', content: '' };
      CHAT_PROMPTS.push(newPrompt);
      _editingId = newPrompt.id;
      _savePrompts();
      renderList();
    };
    header.append(title, addBtn);
    container.appendChild(header);

    const hint = document.createElement('p');
    hint.style.cssText = 'font-size:0.82em;color:var(--text2);margin:0 0 10px;';
    hint.textContent =
      'Add as many named prompts as you like. Select which one to use from the ' +
      'dropdown next to the model selector in the chat bar. You can use following parameters '+
      'to inject date & time in the System Prompt: '+
      '{{date}}, {{time}}, {{weekday}}, {{timezone}}, {{date_iso}}, {{time_24}}, {{datetime}}';
    container.appendChild(hint);

    if (!CHAT_PROMPTS.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text2);font-size:0.82em;padding:3px 0;';
      empty.textContent = 'No prompts configured. Click "+ Add prompt" to create one.';
      container.appendChild(empty);
      return;
    }

    for (const prompt of CHAT_PROMPTS) {
      container.appendChild(_buildRow(prompt));
    }

    // Enable drag-and-drop reordering
    _makeDraggable(
      container,
      () => CHAT_PROMPTS,
      arr => { CHAT_PROMPTS = arr; },
      () => { _savePrompts(); renderList(); }
    );
  }

  function _buildRow(prompt) {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'border:1px solid var(--border);border-radius:5px;margin-bottom:6px;' +
      'background:var(--bg2);overflow:hidden;';
    wrap.dataset.dragId = prompt.id;

    // ── Row header (always visible) ───────────────────────────
    const rowHead = document.createElement('div');
    rowHead.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;';

    // Drag handle
    const dragHandle = document.createElement('span');
    dragHandle.className = 'settings-drag-handle';
    dragHandle.textContent = '⠿';
    dragHandle.title = 'Drag to reorder';

    // Active radio indicator
    const radio = document.createElement('input');
    radio.type    = 'radio';
    radio.name    = 'active-prompt';
    radio.checked = (prompt.id === ACTIVE_PROMPT_ID);
    radio.title   = 'Set as active prompt';
    radio.style.cssText = 'cursor:pointer;accent-color:var(--accent);flex-shrink:0;';
    radio.onclick = e => {
      e.stopPropagation();
      ACTIVE_PROMPT_ID = prompt.id;
      _savePrompts();
      // Update all radios without full re-render
      container.querySelectorAll('input[name="active-prompt"]').forEach(r => {
        r.checked = (r.closest('[data-drag-id]')?.dataset.dragId === ACTIVE_PROMPT_ID);
      });
    };
    wrap.dataset.pid = prompt.id;

    // Name field (inline editable)
    const nameInp = document.createElement('input');
    nameInp.type        = 'text';
    nameInp.value       = prompt.name;
    nameInp.placeholder = 'Prompt name';
    nameInp.style.cssText =
      'flex:1;background:transparent;border:none;outline:none;' +
      'font-weight:600;font-size:0.9em;color:var(--text);min-width:0;cursor:pointer;';
    nameInp.onclick = e => e.stopPropagation();
    nameInp.oninput = () => {
      prompt.name = nameInp.value;
      _savePrompts();
    };

    // Content preview (truncated) — click to expand/collapse editor
    const preview = document.createElement('span');
    preview.style.cssText =
      'flex:2;font-size:0.78em;color:var(--text2);' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    preview.textContent = prompt.content
      ? prompt.content.slice(0, 60) + (prompt.content.length > 60 ? '…' : '')
      : '(empty)';

    // Edit / collapse toggle
    const editBtn = document.createElement('button');
    editBtn.className = 'settings-row-btn';
    const isEditing = (_editingId === prompt.id);
    editBtn.textContent = isEditing ? '▲ Close' : '✎ Edit';
    editBtn.onclick = e => {
      e.stopPropagation();
      _editingId = isEditing ? null : prompt.id;
      renderList();
    };

    // Delete
    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.className   = 'settings-row-btn danger';
    delBtn.title = 'Delete prompt';
    delBtn.onclick = e => {
      e.stopPropagation();
      if (CHAT_PROMPTS.length === 1) {
        // Always keep at least one; just clear content
        prompt.content = '';
        _savePrompts();
        renderList();
        return;
      }
      CHAT_PROMPTS = CHAT_PROMPTS.filter(p => p.id !== prompt.id);
      if (ACTIVE_PROMPT_ID === prompt.id) {
        ACTIVE_PROMPT_ID = CHAT_PROMPTS[0].id;
      }
      if (_editingId === prompt.id) _editingId = null;
      _savePrompts();
      renderList();
    };

    rowHead.append(dragHandle, radio, nameInp, preview, editBtn, delBtn);
    rowHead.onclick = () => {
      _editingId = isEditing ? null : prompt.id;
      renderList();
    };
    wrap.appendChild(rowHead);

    // ── Editor (shown when this prompt is _editingId) ─────────
    if (isEditing) {
      const editorWrap = document.createElement('div');
      editorWrap.style.cssText = 'padding:0 8px 8px;';

      const ta = document.createElement('textarea');
      ta.rows        = 6;
      ta.value       = prompt.content;
      ta.placeholder = 'System prompt text (leave empty to use model default)…';
      ta.style.cssText = INPUT_STYLE + 'resize:vertical;font-family:monospace;margin-top:2px;';
      ta.oninput = () => {
        prompt.content = ta.value;
        // Update preview text
        preview.textContent = ta.value
          ? ta.value.slice(0, 60) + (ta.value.length > 60 ? '…' : '')
          : '(empty)';
        _savePrompts();
      };
      editorWrap.appendChild(ta);
      wrap.appendChild(editorWrap);
    }

    return wrap;
  }

  // ── Public render hook (called by main.js loadSettingsUI + importSettings) ─
  window.renderChatPromptsUI = function() {
    renderList();
    _syncModelBarSelect();
  };

  // Re-render when the prompts nav item is clicked
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    if (btn.dataset.section === 'prompts') {
      btn.addEventListener('click', () => {
        renderList();
        _syncModelBarSelect();
      });
    }
  });

  // Initial render
  renderList();
  _syncModelBarSelect();

})();

// ══ TOOLS SETTINGS SECTION ═══════════════════════════════════
// Injected dynamically so the HTML file needs no changes.
// Inserted just before the row that holds the Save/Close buttons.
// All TOOLS_CONFIG mutations write through to localStorage immediately.

(function _initToolsSection() {

  // ── Inject HTML ─────────────────────────────────────────────
  const sectionHTML = `
<div id="tools-section" style="margin-top:18px;border-top:1px solid var(--border);padding-top:14px;">

  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
    <div style="font-weight:600;font-size:0.97em;display:flex;align-items:center;gap:7px;">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77
          a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91
          a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
      </svg>
      Tool Calling
    </div>
    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:0.88em;color:var(--text2);">
      <input type="checkbox" id="set-tools-enabled"> Enable
    </label>
  </div>

  <p style="font-size:0.82em;color:var(--text2);margin:0 0 12px;">
    Lets the model call HTTP endpoints or MCP servers mid-conversation.
    Requires a model with function/tool calling support (Llama&nbsp;3.x,
    Mistral, Qwen&nbsp;2.5, etc.).
    MCP servers must expose the <em>streamable&nbsp;HTTP</em> transport
    (POST&nbsp;JSON-RPC) — stdio-only servers are not reachable from a browser.
  </p>

  <!-- ── Max Tool Rounds ──────────────────────────────────── -->
  <div style="margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
    <div>
      <div style="font-size:0.88em;font-weight:600;color:var(--text2);">Max tool-call rounds</div>
      <p style="font-size:0.8em;color:var(--text2);margin:2px 0 0;max-width:340px;">
        Caps sequential tool round-trips per turn (anti-runaway safeguard).
        Applies to both direct and backend chat paths. Set to 0 for unlimited.
      </p>
    </div>
    <input type="number" id="set-max-tool-rounds" min="0" step="1" style="width:64px;text-align:center;
      padding:5px 6px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);">
  </div>

  <!-- ── Built-in Tools ───────────────────────────────────── -->
  <div style="margin-bottom:14px;">
    <div style="font-size:0.88em;font-weight:600;color:var(--text2);margin-bottom:6px;">
      Built-in Tools
    </div>
    <p style="font-size:0.82em;color:var(--text2);margin:0 0 8px;">
      Client-side tools resolved instantly without any network call.
      Toggle each one individually — disabled tools are never sent to the model.
    </p>
    <div id="tools-builtin-list"></div>
  </div>

  <!-- ── HTTP Tools ────────────────────────────────────────── -->
  <div style="margin-bottom:14px;">
    <div style="display:flex;align-items:center;justify-content:space-between;
                margin-bottom:6px;font-size:0.88em;font-weight:600;color:var(--text2);">
      <span>HTTP Tools</span>
      <button id="tools-add-http-btn" class="settings-row-btn">+ Add</button>
    </div>
    <div id="tools-http-list"></div>
    <div id="tools-http-form" style="display:none;"></div>
  </div>

  <!-- ── MCP Servers ──────────────────────────────────────── -->
  <div>
    <div style="display:flex;align-items:center;justify-content:space-between;
                margin-bottom:6px;font-size:0.88em;font-weight:600;color:var(--text2);">
      <span>MCP Servers</span>
      <button id="tools-add-mcp-btn" class="settings-row-btn">+ Add</button>
    </div>
    <div id="tools-mcp-list"></div>
    <div id="tools-mcp-form" style="display:none;"></div>
  </div>

</div>`;

  // Inject into the dedicated #section-tools pane in the two-pane layout.
  // Unwrap the outer <div id="tools-section"> and place children directly into
  // the section pane (which already provides padding + title via CSS).
  const sectionTarget = document.getElementById('section-tools');
  if (sectionTarget) {
    const tmp = document.createElement('div');
    tmp.innerHTML = sectionHTML;
    const outer = tmp.firstElementChild; // <div id="tools-section">
    while (outer.firstChild) sectionTarget.appendChild(outer.firstChild);
  } else {
    // Fallback: append to modal
    settingsModal.insertAdjacentHTML('beforeend', sectionHTML);
  }

  // ── Shared helpers ──────────────────────────────────────────
  const ROW_STYLE =
    'display:flex;align-items:center;gap:6px;padding:5px 7px;margin-bottom:4px;' +
    'border:1px solid var(--border);border-radius:5px;background:var(--bg2);font-size:0.84em;';
  const INPUT_STYLE =
    'background:var(--bg3,var(--bg2));color:var(--text);border:1px solid var(--border);' +
    'border-radius:4px;padding:4px 6px;font-size:0.85em;width:100%;box-sizing:border-box;';
  const LABEL_STYLE = 'color:var(--text2);font-size:0.82em;display:block;margin:6px 0 2px;';
  // Buttons use .settings-row-btn CSS class; BTN_STYLE kept for any legacy inline use
  const BTN_STYLE   = '';

  function _id() { return Math.random().toString(36).slice(2, 10); }

  function _saveTools() {
    localStorage.setItem('tools_config', JSON.stringify(TOOLS_CONFIG));
  }

  function _inp(val = '', ph = '') {
    const el = document.createElement('input');
    el.type = 'text'; el.value = val; el.placeholder = ph;
    el.style.cssText = INPUT_STYLE;
    return el;
  }
  function _ta(val = '', ph = '', rows = 3) {
    const el = document.createElement('textarea');
    el.value = val; el.placeholder = ph; el.rows = rows;
    el.style.cssText = INPUT_STYLE + 'resize:vertical;font-family:monospace;';
    return el;
  }
  function _lbl(txt) {
    const el = document.createElement('div');
    el.style.cssText = LABEL_STYLE;
    el.textContent = txt;
    return el;
  }
  function _btn(txt, extra = '') {
    const el = document.createElement('button');
    el.textContent = txt;
    el.className = 'settings-row-btn';
    // extra can carry 'danger', 'primary' class hints or raw colour for delete ✕
    if (extra.includes('var(--red)')) el.classList.add('danger');
    if (extra.includes('var(--accent)') && extra.includes('background')) el.classList.add('primary');
    return el;
  }
  function _status(parent, msg, color = 'var(--text2)') {
    let el = parent.querySelector('.tools-status');
    if (!el) {
      el = document.createElement('div');
      el.className = 'tools-status';
      el.style.cssText = 'font-size:0.8em;margin-top:4px;';
      parent.appendChild(el);
    }
    el.style.color = color;
    el.textContent = msg;
  }

  // ── Drag-and-drop helper for tools lists ───────────────────
  function _makeToolsDraggable(listEl, type) {
    let dragSrcId = null;
    listEl.querySelectorAll('[data-drag-id]').forEach(row => {
      const handle = row.querySelector('.settings-drag-handle');
      if (!handle) return;
      handle.addEventListener('mousedown', () => { row.draggable = true; });
      row.addEventListener('dragstart', e => {
        dragSrcId = row.dataset.dragId;
        row.classList.add('drag-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        row.draggable = false;
        row.classList.remove('drag-dragging');
        listEl.querySelectorAll('[data-drag-id]').forEach(r => r.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        listEl.querySelectorAll('[data-drag-id]').forEach(r => r.classList.remove('drag-over'));
        if (row.dataset.dragId !== dragSrcId) row.classList.add('drag-over');
      });
      row.addEventListener('drop', e => {
        e.preventDefault();
        const targetId = row.dataset.dragId;
        if (!dragSrcId || dragSrcId === targetId) return;
        const items  = TOOLS_CONFIG.filter(t => t.type === type);
        const others = TOOLS_CONFIG.filter(t => t.type !== type);
        const fromIdx = items.findIndex(t => t.id === dragSrcId);
        const toIdx   = items.findIndex(t => t.id === targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        items.splice(toIdx, 0, items.splice(fromIdx, 1)[0]);
        // Rebuild TOOLS_CONFIG preserving non-type items' positions before type items
        TOOLS_CONFIG = [...others, ...items];
        _saveTools();
        type === 'http' ? renderHttpList() : renderMcpList();
      });
    });
  }

  // ── Render ──────────────────────────────────────────────────
  // Declared on the outer window object so importSettings() (above this IIFE)
  // can call them after loading a snapshot that includes tools_config.
  function renderToolsEnabled() {
    const cb = document.getElementById('set-tools-enabled');
    if (cb) cb.checked = TOOLS_ENABLED;
    const mtr = document.getElementById('set-max-tool-rounds');
    if (mtr) mtr.value = MAX_TOOL_ROUNDS;
  }

  // Memory tools are managed in the Memory tab instead (see
  // _initMemorySection's renderMemoryToolsList) — it makes more sense for a
  // user to find/edit them alongside the rest of memory than buried here.
  const MEMORY_TOOL_NAMES = ['save_memory', 'search_memory', 'update_memory'];

  function renderBuiltinList() {
    const list = document.getElementById('tools-builtin-list');
    if (!list) return;
    list.innerHTML = '';
    const catalogue = ((typeof ToolsEngine !== 'undefined') ? ToolsEngine.BUILTIN_CATALOGUE : [])
      .filter(bt => !MEMORY_TOOL_NAMES.includes(bt.name));
    if (!catalogue.length) {
      list.innerHTML = `<div style="color:var(--text2);font-size:0.82em;padding:3px 0;">
        No built-in tools available.</div>`;
      return;
    }
    for (const bt of catalogue) {
      const row = document.createElement('div');
      row.style.cssText = ROW_STYLE;

      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.title   = 'Enable / disable';
      cb.checked = BUILTIN_TOOLS[bt.name] !== false;   // default: enabled
      cb.onchange = () => {
        BUILTIN_TOOLS[bt.name] = cb.checked;
        localStorage.setItem('builtin_tools', JSON.stringify(BUILTIN_TOOLS));
      };

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;';
      info.innerHTML =
        `<span style="font-weight:600;">${bt.name}</span>` +
        (bt.displayName || bt.description
          ? `<br><span style="font-size:0.8em;color:var(--text2);">${bt.displayName || bt.description}</span>`
          : '');

      const badge = document.createElement('span');
      badge.style.cssText =
        'font-size:0.72em;padding:1px 6px;border-radius:10px;' +
        'background:var(--bg3,var(--bg2));color:var(--text2);white-space:nowrap;';
      badge.textContent = 'built-in';

      row.append(cb, info, badge);

      // generate_image is the only built-in with user-configurable settings
      // (description + default size) so far — special-cased rather than a
      // generic mechanism since it's currently the only one that needs it.
      if (bt.name === 'generate_image') {
        const editBtn = _btn('Edit');
        editBtn.onclick = () => {
          const existing = list.querySelector('.tools-builtin-config[data-for="generate_image"]');
          if (existing) { existing.remove(); return; }
          list.appendChild(_buildImageToolConfigPanel());
        };
        row.append(editBtn);
      }

      list.appendChild(row);
    }
  }

  // Inline config panel for the generate_image built-in — description
  // (with a reset-to-default) and default width/height, mirroring the
  // HTTP-tool edit-form pattern (_inp/_ta/_lbl/_btn) but persisted to its
  // own config.js keys rather than TOOLS_CONFIG, since this isn't an HTTP tool.
  function _buildImageToolConfigPanel() {
    const panel = document.createElement('div');
    panel.className = 'tools-builtin-config';
    panel.dataset.for = 'generate_image';
    panel.style.cssText =
      'padding:8px 9px;margin:-2px 0 6px;border:1px solid var(--border);border-top:none;' +
      'border-radius:0 0 5px 5px;background:var(--bg);font-size:0.84em;';

    panel.appendChild(_lbl('Description sent to the model'));
    const descTa = _ta(IMG_TOOL_DESCRIPTION, '', 4);
    panel.appendChild(descTa);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:0.78em;color:var(--text2);margin:4px 0 0;';
    hint.textContent = 'Supports {{img_tool_default_width}} / {{img_tool_default_height}} placeholders.';
    panel.appendChild(hint);

    const sizeRow = document.createElement('div');
    sizeRow.style.cssText = 'display:flex;gap:10px;margin-top:8px;';

    const widthWrap = document.createElement('div');
    widthWrap.style.cssText = 'flex:1;';
    widthWrap.appendChild(_lbl('Default width'));
    const widthInp = document.createElement('input');
    widthInp.type = 'number'; widthInp.min = 64; widthInp.max = 1920; widthInp.step = 16;
    widthInp.value = IMG_TOOL_DEFAULT_WIDTH;
    widthInp.style.cssText = INPUT_STYLE;
    widthWrap.appendChild(widthInp);

    const heightWrap = document.createElement('div');
    heightWrap.style.cssText = 'flex:1;';
    heightWrap.appendChild(_lbl('Default height'));
    const heightInp = document.createElement('input');
    heightInp.type = 'number'; heightInp.min = 64; heightInp.max = 1920; heightInp.step = 16;
    heightInp.value = IMG_TOOL_DEFAULT_HEIGHT;
    heightInp.style.cssText = INPUT_STYLE;
    heightWrap.appendChild(heightInp);

    sizeRow.append(widthWrap, heightWrap);
    panel.appendChild(sizeRow);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;';

    const resetBtn = _btn('Reset description');
    resetBtn.onclick = () => { descTa.value = DEFAULT_IMG_TOOL_DESCRIPTION; };

    const saveBtn = _btn('Save', 'background:var(--accent);');
    saveBtn.onclick = () => {
      let w = Math.round(Number(widthInp.value))  || 512;
      let h = Math.round(Number(heightInp.value)) || 512;
      w = Math.min(1920, Math.max(64, w - (w % 16)));
      h = Math.min(1920, Math.max(64, h - (h % 16)));
      widthInp.value = w; heightInp.value = h;

      IMG_TOOL_DESCRIPTION    = descTa.value.trim() || DEFAULT_IMG_TOOL_DESCRIPTION;
      IMG_TOOL_DEFAULT_WIDTH  = w;
      IMG_TOOL_DEFAULT_HEIGHT = h;
      localStorage.setItem('img_tool_description', IMG_TOOL_DESCRIPTION);
      localStorage.setItem('img_tool_default_width',  IMG_TOOL_DEFAULT_WIDTH);
      localStorage.setItem('img_tool_default_height', IMG_TOOL_DEFAULT_HEIGHT);
      _status(panel, 'Saved.', 'var(--green)');
    };

    btnRow.append(resetBtn, saveBtn);
    panel.appendChild(btnRow);

    return panel;
  }

  function renderHttpList() {
    const list = document.getElementById('tools-http-list');
    if (!list) return;
    list.innerHTML = '';
    const httpTools = TOOLS_CONFIG.filter(t => t.type === 'http');
    if (!httpTools.length) {
      list.innerHTML = `<div style="color:var(--text2);font-size:0.82em;padding:3px 0;">
        No HTTP tools configured.</div>`;
      return;
    }
    for (const tool of httpTools) {
      const row = document.createElement('div');
      row.style.cssText = ROW_STYLE;
      row.dataset.dragId = tool.id;

      const dragHandle = document.createElement('span');
      dragHandle.className = 'settings-drag-handle';
      dragHandle.textContent = '⠿';
      dragHandle.title = 'Drag to reorder';

      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = tool.enabled !== false;
      cb.title = 'Enable / disable';
      cb.onchange = () => {
        tool.enabled = cb.checked;
        _saveTools();
        // Keep model-bar button in sync if this tool is pinned
        if (typeof renderToolHeaderButtons === 'function') renderToolHeaderButtons();
      };

      const name = document.createElement('span');
      name.style.cssText = 'flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      name.textContent = tool.name;
      name.title = tool.description || tool.url;

      const method = document.createElement('span');
      method.style.cssText = 'color:var(--accent);font-size:0.8em;min-width:36px;';
      method.textContent = tool.method || 'GET';

      // Pin indicator (shown when tool.headerPin is true)
      const pinDot = document.createElement('span');
      pinDot.title = tool.headerPin ? 'Pinned to model-bar' : '';
      pinDot.style.cssText = 'font-size:0.75em;color:var(--text2);';
      pinDot.textContent   = tool.headerPin ? '📌' : '';

      const editBtn = _btn('Edit');
      editBtn.onclick = () => openHttpForm(tool.id);

      const delBtn = _btn('✕', 'color:var(--red);');
      delBtn.onclick = () => {
        TOOLS_CONFIG = TOOLS_CONFIG.filter(t => t.id !== tool.id);
        _saveTools();
        if (typeof renderToolHeaderButtons === 'function') renderToolHeaderButtons();
        renderHttpList();
      };

      row.append(dragHandle, cb, name, method, pinDot, editBtn, delBtn);
      list.appendChild(row);
    }
    _makeToolsDraggable(list, 'http');
  }

  function renderMcpList() {
    const list = document.getElementById('tools-mcp-list');
    if (!list) return;
    list.innerHTML = '';
    const mcpServers = TOOLS_CONFIG.filter(t => t.type === 'mcp');
    if (!mcpServers.length) {
      list.innerHTML = `<div style="color:var(--text2);font-size:0.82em;padding:3px 0;">
        No MCP servers configured.</div>`;
      return;
    }
    for (const srv of mcpServers) {
      const row = document.createElement('div');
      row.style.cssText = ROW_STYLE + 'flex-wrap:wrap;';
      row.dataset.dragId = srv.id;

      const top = document.createElement('div');
      top.style.cssText = 'display:flex;align-items:center;gap:6px;width:100%;';

      const dragHandle = document.createElement('span');
      dragHandle.className = 'settings-drag-handle';
      dragHandle.textContent = '⠿';
      dragHandle.title = 'Drag to reorder';

      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = srv.enabled !== false;
      cb.title = 'Enable / disable';
      cb.onchange = () => { srv.enabled = cb.checked; _saveTools(); };

      const name = document.createElement('span');
      name.style.cssText = 'flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      name.textContent = srv.name;
      name.title = srv.url;

      const count = document.createElement('span');
      count.style.cssText = 'color:var(--text2);font-size:0.8em;';
      const n = (srv.discoveredTools || []).length;
      count.textContent = n ? `${n} tool${n !== 1 ? 's' : ''}` : 'not discovered';
      count.style.color = n ? 'var(--green)' : 'var(--text2)';

      const editBtn = _btn('Edit');
      editBtn.onclick = () => openMcpForm(srv.id);

      const delBtn = _btn('✕', 'color:var(--red);');
      delBtn.onclick = () => {
        TOOLS_CONFIG = TOOLS_CONFIG.filter(t => t.id !== srv.id);
        _saveTools(); renderMcpList();
      };

      top.append(dragHandle, cb, name, count, editBtn, delBtn);
      row.appendChild(top);

      // Show discovered tool names as subtle chips
      if (n) {
        const chips = document.createElement('div');
        chips.style.cssText = 'width:100%;margin-top:4px;display:flex;flex-wrap:wrap;gap:3px;';
        for (const mt of srv.discoveredTools) {
          const chip = document.createElement('label');
          chip.style.cssText =
            'display:flex;align-items:center;gap:3px;font-size:0.76em;' +
            'padding:1px 6px;border-radius:10px;border:1px solid var(--border);' +
            'cursor:pointer;color:var(--text2);';
          const mcb = document.createElement('input');
          mcb.type = 'checkbox'; mcb.checked = mt.enabled !== false;
          mcb.onchange = () => { mt.enabled = mcb.checked; _saveTools(); };
          chip.appendChild(mcb);
          chip.appendChild(document.createTextNode(mt.name));
          chips.appendChild(chip);
        }
        row.appendChild(chips);
      }

      list.appendChild(row);
    }
    _makeToolsDraggable(list, 'mcp');
  }

  // ── HTTP Tool form ──────────────────────────────────────────
  function openHttpForm(editId) {
    const formEl = document.getElementById('tools-http-form');
    if (!formEl) return;
    const existing = editId ? TOOLS_CONFIG.find(t => t.id === editId) : null;

    formEl.style.display = 'block';
    formEl.innerHTML = '';

    const box = document.createElement('div');
    box.style.cssText =
      'border:1px solid var(--border);border-radius:6px;padding:10px 12px;' +
      'background:var(--bg2);margin-bottom:6px;';

    const heading = document.createElement('div');
    heading.style.cssText = 'font-weight:600;font-size:0.9em;margin-bottom:8px;';
    heading.textContent = existing ? 'Edit HTTP Tool' : 'New HTTP Tool';

    // Name
    box.appendChild(_lbl('Function name (snake_case, no spaces)'));
    const inpName = _inp(existing?.name || '', 'e.g. get_weather');
    box.appendChild(inpName);

    // Description
    box.appendChild(_lbl('Description (shown to model)'));
    const inpDesc = _inp(existing?.description || '', 'Returns current weather for a city');
    box.appendChild(inpDesc);

    // URL
    box.appendChild(_lbl('URL (use {{param}} for path/query substitution)'));
    const inpUrl = _inp(existing?.url || '', 'https://api.example.com/data?q={{query}}');
    box.appendChild(inpUrl);

    // Method
    box.appendChild(_lbl('Method'));
    const selMethod = document.createElement('select');
    selMethod.style.cssText = INPUT_STYLE + 'width:auto;';
    for (const m of ['GET','POST','PUT','PATCH','DELETE']) {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
      if ((existing?.method || 'GET') === m) opt.selected = true;
      selMethod.appendChild(opt);
    }
    box.appendChild(selMethod);

    // Headers
    box.appendChild(_lbl('Headers (one per line: Key: Value)'));
    const headersObj = existing?.headers || {};
    const headersStr = Object.entries(headersObj).map(([k,v]) => `${k}: ${v}`).join('\n');
    const inpHeaders = _ta(headersStr, 'Authorization: Bearer YOUR_KEY\nContent-Type: application/json', 3);
    box.appendChild(inpHeaders);

    // Body template
    box.appendChild(_lbl('Body template (POST/PUT — leave empty to auto-serialize args as JSON)'));
    const inpBody = _ta(existing?.bodyTemplate || '', '{"city": "{{city}}", "units": "metric"}', 3);
    box.appendChild(inpBody);

    // Parameters (JSON Schema)
    box.appendChild(_lbl('Parameters — JSON Schema object (properties the model can pass)'));
    const defaultParams = JSON.stringify(
      existing?.parameters || { type:'object', properties:{}, required:[] }, null, 2
    );
    const inpParams = _ta(defaultParams, '', 5);
    box.appendChild(inpParams);

    // ── Header pin ─────────────────────────────────────────────
    const pinRow = document.createElement('label');
    pinRow.style.cssText =
      'display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer;font-size:0.85em;';
    const pinCb = document.createElement('input');
    pinCb.type = 'checkbox'; pinCb.checked = !!existing?.headerPin;
    const pinLbl = document.createElement('span');
    pinLbl.textContent = 'Pin toggle button to model-bar (chat mode only)';
    pinRow.append(pinCb, pinLbl);
    box.appendChild(pinRow);

    // ── Button icon ─────────────────────────────────────────────
    const iconSection = document.createElement('div');
    iconSection.id = '_icon-section';
    iconSection.style.display = pinCb.checked ? '' : 'none';

    iconSection.appendChild(_lbl('Button icon — paste an SVG element (shown in chat model-bar)'));
    const inpIcon = _ta(existing?.icon || '', '<svg viewBox="0 0 24 24" ...>...</svg>', 3);
    inpIcon.style.fontFamily = 'monospace';
    iconSection.appendChild(inpIcon);

    box.appendChild(iconSection);
    pinCb.addEventListener('change', () => {
      iconSection.style.display = pinCb.checked ? '' : 'none';
    });

    // ── Response filter ──────────────────────────────────────────
    const filterDiv = document.createElement('div');
    filterDiv.style.cssText =
      'margin-top:10px;padding:8px 10px;border:1px solid var(--border);' +
      'border-radius:5px;background:var(--bg3,var(--bg));';

    const filterHeading = document.createElement('div');
    filterHeading.style.cssText = 'font-size:0.82em;font-weight:600;color:var(--text2);margin-bottom:6px;';
    filterHeading.textContent = 'Response filter (trims JSON before handing to model)';
    filterDiv.appendChild(filterHeading);

    filterDiv.appendChild(_lbl('Path to results array — dot notation (e.g. web.results, leave empty for root)'));
    const inpFilterPath = _inp(existing?.responseFilter?.path || '', 'web.results');
    filterDiv.appendChild(inpFilterPath);

    filterDiv.appendChild(_lbl('Keep only these fields — comma-separated whitelist (applied to each item)'));
    const inpFilterPick = _inp(existing?.responseFilter?.pick || '', 'title,url,description');
    filterDiv.appendChild(inpFilterPick);

    filterDiv.appendChild(_lbl('Drop these fields — comma-separated blacklist (ignored when Keep is set)'));
    const inpFilterDrop = _inp(existing?.responseFilter?.drop || '', 'deep_results,profile,thumbnail');
    filterDiv.appendChild(inpFilterDrop);

    filterDiv.appendChild(_lbl('Max results — limit items forwarded to model (0 = no limit)'));
    const inpFilterLimit = _inp(
      existing?.responseFilter?.limit != null ? String(existing.responseFilter.limit) : '0',
      '0'
    );
    inpFilterLimit.type = 'number';
    inpFilterLimit.min  = '0';
    inpFilterLimit.step = '1';
    inpFilterLimit.style.cssText += 'width:100px;';
    filterDiv.appendChild(inpFilterLimit);

    box.appendChild(filterDiv);

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;';

    const saveBtn2 = _btn(existing ? 'Save changes' : 'Add tool', 'background:var(--accent);color:#111;');
    saveBtn2.onclick = () => {
      const nameVal = inpName.value.trim().replace(/\s+/g, '_');
      if (!nameVal) { _status(box, 'Function name is required.', 'var(--red)'); return; }
      if (!inpUrl.value.trim()) { _status(box, 'URL is required.', 'var(--red)'); return; }

      let params;
      try { params = JSON.parse(inpParams.value || '{}'); }
      catch { _status(box, 'Parameters must be valid JSON.', 'var(--red)'); return; }

      const headers = {};
      for (const line of inpHeaders.value.split('\n')) {
        const idx = line.indexOf(':');
        if (idx < 1) continue;
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }

      if (existing) {
        Object.assign(existing, {
          name:           nameVal,
          description:    inpDesc.value.trim(),
          url:            inpUrl.value.trim(),
          method:         selMethod.value,
          headers,
          bodyTemplate:   inpBody.value.trim(),
          parameters:     params,
          icon:           inpIcon.value.trim(),
          headerPin:      pinCb.checked,
          responseFilter: {
            path:  inpFilterPath.value.trim(),
            pick:  inpFilterPick.value.trim(),
            drop:  inpFilterDrop.value.trim(),
            limit: parseInt(inpFilterLimit.value) || 0
          }
        });
      } else {
        TOOLS_CONFIG.push({
          id:             _id(),
          type:           'http',
          enabled:        true,
          name:           nameVal,
          description:    inpDesc.value.trim(),
          url:            inpUrl.value.trim(),
          method:         selMethod.value,
          headers,
          bodyTemplate:   inpBody.value.trim(),
          parameters:     params,
          icon:           inpIcon.value.trim(),
          headerPin:      pinCb.checked,
          responseFilter: {
            path:  inpFilterPath.value.trim(),
            pick:  inpFilterPick.value.trim(),
            drop:  inpFilterDrop.value.trim(),
            limit: parseInt(inpFilterLimit.value) || 0
          }
        });
      }
      _saveTools();
      // Re-render model-bar buttons to reflect any pin/icon changes
      if (typeof renderToolHeaderButtons === 'function') renderToolHeaderButtons();
      formEl.style.display = 'none';
      renderHttpList();
    };

    const cancelBtn = _btn('Cancel');
    cancelBtn.onclick = () => { formEl.style.display = 'none'; };

    btnRow.append(saveBtn2, cancelBtn);
    box.prepend(heading);
    box.appendChild(btnRow);
    formEl.appendChild(box);
    inpName.focus();
  }

  // ── MCP Server form ─────────────────────────────────────────
  function openMcpForm(editId) {
    const formEl = document.getElementById('tools-mcp-form');
    if (!formEl) return;
    const existing = editId ? TOOLS_CONFIG.find(t => t.id === editId) : null;

    formEl.style.display = 'block';
    formEl.innerHTML = '';

    const box = document.createElement('div');
    box.style.cssText =
      'border:1px solid var(--border);border-radius:6px;padding:10px 12px;' +
      'background:var(--bg2);margin-bottom:6px;';

    const heading = document.createElement('div');
    heading.style.cssText = 'font-weight:600;font-size:0.9em;margin-bottom:8px;';
    heading.textContent = existing ? 'Edit MCP Server' : 'New MCP Server';
    box.appendChild(heading);

    box.appendChild(_lbl('Display name'));
    const inpName = _inp(existing?.name || '', 'My MCP Server');
    box.appendChild(inpName);

    box.appendChild(_lbl('Server URL (streamable HTTP endpoint)'));
    const inpUrl = _inp(existing?.url || '', 'https://my-mcp-server.example.com/mcp');
    box.appendChild(inpUrl);

    // Discover button + status
    const discoverRow = document.createElement('div');
    discoverRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:8px;';
    const discoverBtn = _btn('⟳ Discover tools', 'background:var(--bg3,var(--bg));');
    discoverRow.appendChild(discoverBtn);
    box.appendChild(discoverRow);

    // Discovered tools list (populated after discover)
    const discoveredList = document.createElement('div');
    discoveredList.style.cssText = 'margin-top:8px;';
    box.appendChild(discoveredList);

    function renderDiscovered(tools) {
      discoveredList.innerHTML = '';
      if (!tools?.length) return;
      const label = document.createElement('div');
      label.style.cssText = LABEL_STYLE;
      label.textContent = `Discovered ${tools.length} tool${tools.length !== 1 ? 's' : ''} — toggle to enable:`;
      discoveredList.appendChild(label);
      for (const mt of tools) {
        const row = document.createElement('label');
        row.style.cssText =
          'display:flex;align-items:flex-start;gap:5px;margin-bottom:4px;cursor:pointer;';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = mt.enabled !== false;
        cb.onchange = () => { mt.enabled = cb.checked; };
        const info = document.createElement('div');
        info.style.cssText = 'flex:1;font-size:0.83em;';
        info.innerHTML =
          `<strong style="color:var(--accent);">${mt.name}</strong>` +
          (mt.description ? `<br><span style="color:var(--text2);">${mt.description}</span>` : '');
        row.append(cb, info);
        discoveredList.appendChild(row);
      }
    }

    // Pre-populate if editing an existing server
    if (existing?.discoveredTools?.length) renderDiscovered(existing.discoveredTools);

    let lastDiscovered = existing?.discoveredTools ? [...existing.discoveredTools] : [];

    discoverBtn.onclick = async () => {
      const url = inpUrl.value.trim();
      if (!url) { _status(box, 'Enter a URL first.', 'var(--red)'); return; }
      discoverBtn.disabled = true;
      _status(box, 'Connecting…', 'var(--text2)');
      try {
        const tools = await ToolsEngine.discoverMcpTools(url);
        // Preserve existing enabled states where name matches
        const oldMap = Object.fromEntries(lastDiscovered.map(t => [t.name, t.enabled]));
        for (const t of tools) {
          if (t.name in oldMap) t.enabled = oldMap[t.name];
        }
        lastDiscovered = tools;
        renderDiscovered(tools);
        _status(box, `Found ${tools.length} tool${tools.length !== 1 ? 's' : ''}.`, 'var(--green)');
      } catch (e) {
        _status(box, 'Discovery failed: ' + e.message, 'var(--red)');
      } finally {
        discoverBtn.disabled = false;
      }
    };

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:10px;';

    const saveBtn2 = _btn(existing ? 'Save changes' : 'Add server', 'background:var(--accent);color:#111;');
    saveBtn2.onclick = () => {
      const nameVal = inpName.value.trim();
      if (!nameVal) { _status(box, 'Name is required.', 'var(--red)'); return; }
      if (!inpUrl.value.trim()) { _status(box, 'URL is required.', 'var(--red)'); return; }

      if (existing) {
        Object.assign(existing, {
          name:            nameVal,
          url:             inpUrl.value.trim(),
          discoveredTools: lastDiscovered
        });
      } else {
        TOOLS_CONFIG.push({
          id:              _id(),
          type:            'mcp',
          enabled:         true,
          name:            nameVal,
          url:             inpUrl.value.trim(),
          discoveredTools: lastDiscovered
        });
      }
      _saveTools();
      formEl.style.display = 'none';
      renderMcpList();
    };

    const cancelBtn = _btn('Cancel');
    cancelBtn.onclick = () => { formEl.style.display = 'none'; };

    btnRow.append(saveBtn2, cancelBtn);
    box.appendChild(btnRow);
    formEl.appendChild(box);
    inpName.focus();
  }

  // ── Wire buttons ────────────────────────────────────────────
  document.getElementById('tools-add-http-btn')?.addEventListener('click', () => openHttpForm(null));
  document.getElementById('tools-add-mcp-btn')?.addEventListener('click',  () => openMcpForm(null));

  document.getElementById('set-tools-enabled')?.addEventListener('change', e => {
    TOOLS_ENABLED = e.target.checked;
    localStorage.setItem('tools_enabled', TOOLS_ENABLED);
  });

  document.getElementById('set-max-tool-rounds')?.addEventListener('change', e => {
    const n = parseInt(e.target.value);
    MAX_TOOL_ROUNDS = (Number.isFinite(n) && n >= 0) ? n : 5;
    e.target.value = MAX_TOOL_ROUNDS;
    localStorage.setItem('max_tool_rounds', MAX_TOOL_ROUNDS);
  });

  // ── Refresh hook — fired by importSettings and modal open ────
  // Any code outside this IIFE can trigger a full re-render by dispatching
  // a 'tools:refresh' event on settingsModal instead of calling the
  // IIFE-scoped render functions directly.
  settingsModal.addEventListener('tools:refresh', () => {
    renderToolsEnabled();
    renderBuiltinList();
    renderHttpList();
    renderMcpList();
  });

  // Re-render whenever the settings modal is opened (picks up any
  // TOOLS_CONFIG changes made while the modal was closed).
  document.getElementById('settings-open-btn')?.addEventListener('click', () => {
    renderToolsEnabled();
    renderBuiltinList();
    renderHttpList();
    renderMcpList();
  });

  // ── Initial render ──────────────────────────────────────────
  renderToolsEnabled();
  renderBuiltinList();
  renderHttpList();
  renderMcpList();

})();

// ── Initial population of settings fields ─────────────────────
// Called here (end of settings.js) rather than from main.js's init IIFE,
// because the DOM refs above (setApiUrl, setTemp, …) must exist first.
// This is the call that was previously broken in main.js.
// Also kick off a model fetch — safety net in case the main.js IIFE threw
// (e.g. inputEl/chatInput undefined) and checkOllama() never ran on load.

// ── Inject Client ID override field into the Server settings section ──
// Done here (JS injection) so the HTML file needs no changes, consistent
// with how the Tools section is added.
(function _injectClientIdField() {
  // Target: #section-server if it exists, otherwise fall back to the
  // first settings section that contains #set-api-url.
  const apiUrlEl = document.getElementById('set-api-url');
  if (!apiUrlEl) return;
  // Walk up to the nearest .settings-section or #section-* parent
  const section = apiUrlEl.closest('[id^="section-"]') || apiUrlEl.closest('.settings-section');
  if (!section) return;

  // Only inject once
  if (document.getElementById('set-client-id-override')) return;

  const wrapper = document.createElement('div');
  wrapper.style.cssText =
    'margin-top:18px;border-top:1px solid var(--border);padding-top:14px;';

  wrapper.innerHTML = `
    <div style="font-weight:600;font-size:0.97em;margin-bottom:6px;">
      Instance Client ID
    </div>
    <p style="font-size:0.82em;color:var(--text2);margin:0 0 8px;">
      Each browser gets a unique auto-generated ID that routes backend jobs to the
      right instance. Override it below to make multiple instances share the same
      job queue (they will all see and stream each other's jobs).
      Leave empty to keep using the auto-assigned ID.
    </p>
    <div style="display:flex;gap:6px;align-items:center;">
      <input id="set-client-id-override" type="text"
        style="flex:1;background:var(--bg3,var(--bg2));color:var(--text);
               border:1px solid var(--border);border-radius:4px;
               padding:4px 8px;font-size:0.85em;font-family:monospace;"
        autocomplete="off" spellcheck="false" />
      <button id="client-id-clear-btn"
        style="font-size:0.8em;padding:3px 8px;cursor:pointer;color:var(--text2);"
        title="Clear override — revert to auto-assigned ID">✕ Clear</button>
    </div>
    <div style="font-size:0.76em;color:var(--text2);margin-top:4px;">
      Auto-assigned ID (active when field is empty):
      <span id="client-id-display"
        style="font-family:monospace;color:var(--accent);user-select:all;"></span>
    </div>`;

  section.appendChild(wrapper);

  // Populate the auto-ID display span
  const display = document.getElementById('client-id-display');
  if (display && typeof CLIENT_ID !== 'undefined') display.textContent = CLIENT_ID;

  // Clear button wipes the override field (the actual save still happens on Save)
  document.getElementById('client-id-clear-btn')?.addEventListener('click', () => {
    const inp = document.getElementById('set-client-id-override');
    if (inp) inp.value = '';
  });
})();

// ══ MEMORY SETTINGS SECTION ═══════════════════════════════════
// Injected dynamically, same approach as _initToolsSection above — no
// index.html changes needed beyond the empty #section-memory container
// and the nav button. Enable/top-k/min-score write straight to
// localStorage on change (no Save button needed, same as Tool Calling).
// The entries list talks to /api/memory/* via the helpers memory.js
// exposes on window (fetchMemoryList / updateMemoryEntry / deleteMemoryEntry).
//
// Also owns the UI (enable + editable description) for the three memory
// built-in tools (save_memory / search_memory / update_memory) — they're
// deliberately NOT shown in the generic Tool Calling → Built-in list
// (see the exclusion filter inside renderBuiltinList, _initToolsSection
// above); it makes more sense for a user to manage them alongside the
// rest of memory than buried in the general tools list. The tool
// definitions themselves still live in tools.js (ToolsEngine.BUILTIN_CATALOGUE)
// — only where they're surfaced in Settings changes.

(function _initMemorySection() {

  const ENTRIES_PAGE_SIZE = 10;

  const sectionHTML = `
<div id="memory-section" style="margin-top:0;">

  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
    <div style="font-weight:600;font-size:0.97em;display:flex;align-items:center;gap:7px;"
         title="One global memory store shared across every chat. Relevant memories are retrieved automatically on every turn; the model can also save, search, and update memories itself. Backed by human-readable markdown files on the server (source of truth) plus a Qdrant index for search.">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a4 4 0 0 0-4 4v1.17A5 5 0 0 0 5 12v6a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-6a5 5 0 0 0-3-4.83V6a4 4 0 0 0-4-4z"/>
        <path d="M9 10v4M15 10v4M9 17v1M15 17v1"/>
      </svg>
      Long-Term Memory
    </div>
    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:0.88em;color:var(--text2);">
      <input type="checkbox" id="set-memory-enabled"> Enable
    </label>
  </div>

  <!-- ── Retrieval tuning ─────────────────────────────────── -->
  <div class="settings-grid" style="margin-bottom:14px;">
    <label title="How many memories are retrieved per message">Top-K</label>
    <input type="number" id="set-memory-top-k" min="1" max="20" step="1" placeholder="5" style="width:70px;">

    <label title="Only inject memories scoring at or above this (0–1, cosine similarity)">Minimum score</label>
    <div style="display:flex;align-items:center;gap:8px;">
      <input type="range" id="set-memory-min-score" min="0" max="1" step="0.01" style="flex:1;"
             title="Only inject memories scoring at or above this (0–1, cosine similarity)">
      <span id="memory-min-score-label" style="font-size:0.82em;color:var(--text2);width:34px;text-align:right;">0.55</span>
    </div>
  </div>

  <!-- ── Memory tools ─────────────────────────────────────── -->
  <div style="margin-bottom:16px;">
    <div style="font-size:0.88em;font-weight:600;color:var(--text2);margin-bottom:6px;"
         title="The model calls these itself to save, search, and update memories. Toggle or edit what's sent to the model for each.">
      Memory Tools
    </div>
    <div id="memory-tools-list"></div>
  </div>

  <!-- ── Entries browser ──────────────────────────────────── -->
  <div>
    <div style="display:flex;align-items:center;justify-content:space-between;
                margin-bottom:6px;font-size:0.88em;font-weight:600;color:var(--text2);">
      <span>Saved Memories <span id="memory-entries-count" style="font-weight:400;color:var(--text-dim);"></span></span>
      <div style="display:flex;gap:6px;">
        <button id="memory-reindex-btn" class="settings-row-btn" title="Rebuild the search index from the markdown files — use after editing files by hand or changing the embed model">Reindex</button>
        <button id="memory-refresh-btn" class="settings-row-btn">Refresh</button>
      </div>
    </div>
    <input type="text" id="memory-filter-input" placeholder="Filter memories…"
           style="background:var(--bg3,var(--bg2));color:var(--text);border:1px solid var(--border);
                  border-radius:4px;padding:5px 8px;font-size:0.85em;width:100%;box-sizing:border-box;margin-bottom:6px;">
    <div id="memory-entries-status" style="font-size:0.8em;color:var(--text2);margin-bottom:6px;"></div>
    <div id="memory-entries-list"></div>
    <div id="memory-load-more-wrap" style="text-align:center;margin-top:8px;"></div>
  </div>

</div>`;

  const sectionTarget = document.getElementById('section-memory');
  if (sectionTarget) {
    const tmp = document.createElement('div');
    tmp.innerHTML = sectionHTML;
    const outer = tmp.firstElementChild;
    while (outer.firstChild) sectionTarget.appendChild(outer.firstChild);
  } else {
    settingsModal.insertAdjacentHTML('beforeend', sectionHTML);
  }

  // ── Shared local UI helpers (mirrors _initToolsSection's _ta/_lbl/_btn,
  //    kept as separate copies since that IIFE's are private to its own
  //    closure) ─────────────────────────────────────────────────────────
  const INPUT_STYLE =
    'background:var(--bg3,var(--bg2));color:var(--text);border:1px solid var(--border);' +
    'border-radius:4px;padding:4px 6px;font-size:0.85em;width:100%;box-sizing:border-box;';
  const ROW_STYLE =
    'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);';

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function _fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }
  function _status(msg, color = 'var(--text2)') {
    const el = document.getElementById('memory-entries-status');
    if (!el) return;
    el.style.color = color;
    el.textContent = msg;
  }
  function _ta(val = '', ph = '', rows = 3) {
    const el = document.createElement('textarea');
    el.value = val;
    el.placeholder = ph;
    el.rows = rows;
    el.style.cssText = INPUT_STYLE + 'resize:vertical;font-family:inherit;';
    return el;
  }
  function _btn(txt, extra = '') {
    const b = document.createElement('button');
    b.textContent = txt;
    b.className = 'settings-row-btn';
    if (extra) b.style.cssText = extra;
    return b;
  }
  function _panelStatus(panel, msg, color = 'var(--text2)') {
    let el = panel.querySelector('.panel-status');
    if (!el) {
      el = document.createElement('div');
      el.className = 'panel-status';
      el.style.cssText = 'font-size:0.78em;margin-top:6px;';
      panel.appendChild(el);
    }
    el.style.color = color;
    el.textContent = msg;
  }

  // ── Enable toggle ────────────────────────────────────────────
  const enabledCb = document.getElementById('set-memory-enabled');
  if (enabledCb) {
    enabledCb.checked = MEMORY_ENABLED;
    enabledCb.addEventListener('change', () => {
      MEMORY_ENABLED = enabledCb.checked;
      localStorage.setItem('memory_enabled', MEMORY_ENABLED);
      // Keep the model-bar toggle (memory.js) in sync — including its
      // active-color class, not just the checked state.
      if (typeof _syncMemoryToggleUI === 'function') _syncMemoryToggleUI(MEMORY_ENABLED);
    });
  }

  // ── Top-K ────────────────────────────────────────────────────
  const topKInput = document.getElementById('set-memory-top-k');
  if (topKInput) {
    topKInput.value = MEMORY_TOP_K;
    topKInput.addEventListener('change', () => {
      MEMORY_TOP_K = parseInt(topKInput.value) || 5;
      localStorage.setItem('memory_top_k', MEMORY_TOP_K);
    });
  }

  // ── Minimum score ────────────────────────────────────────────
  const scoreInput = document.getElementById('set-memory-min-score');
  const scoreLabel = document.getElementById('memory-min-score-label');
  if (scoreInput) {
    scoreInput.value = MEMORY_MIN_SCORE;
    if (scoreLabel) scoreLabel.textContent = MEMORY_MIN_SCORE.toFixed(2);
    scoreInput.addEventListener('input', () => {
      MEMORY_MIN_SCORE = parseFloat(scoreInput.value);
      if (scoreLabel) scoreLabel.textContent = MEMORY_MIN_SCORE.toFixed(2);
      localStorage.setItem('memory_min_score', MEMORY_MIN_SCORE);
    });
  }

  // ── Memory tools (save_memory / search_memory / update_memory) ────────
  // Moved here from the generic Tool Calling → Built-in list (see the
  // exclusion filter in renderBuiltinList, _initToolsSection above).
  const MEMORY_TOOL_DESC_CONFIG = {
    save_memory:   { get: () => MEMORY_SAVE_TOOL_DESCRIPTION,   set: v => MEMORY_SAVE_TOOL_DESCRIPTION   = v, def: () => DEFAULT_MEMORY_SAVE_TOOL_DESCRIPTION,   key: 'memory_save_tool_description' },
    search_memory: { get: () => MEMORY_SEARCH_TOOL_DESCRIPTION, set: v => MEMORY_SEARCH_TOOL_DESCRIPTION = v, def: () => DEFAULT_MEMORY_SEARCH_TOOL_DESCRIPTION, key: 'memory_search_tool_description' },
    update_memory: { get: () => MEMORY_UPDATE_TOOL_DESCRIPTION, set: v => MEMORY_UPDATE_TOOL_DESCRIPTION = v, def: () => DEFAULT_MEMORY_UPDATE_TOOL_DESCRIPTION, key: 'memory_update_tool_description' },
  };

  function renderMemoryToolsList() {
    const list = document.getElementById('memory-tools-list');
    if (!list) return;
    list.innerHTML = '';
    const catalogue = (typeof ToolsEngine !== 'undefined') ? ToolsEngine.BUILTIN_CATALOGUE : [];

    for (const name of ['save_memory', 'search_memory', 'update_memory']) {
      const bt = catalogue.find(t => t.name === name);
      if (!bt) continue;
      const cfg = MEMORY_TOOL_DESC_CONFIG[name];

      const row = document.createElement('div');
      row.style.cssText = ROW_STYLE;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.title = 'Enable / disable';
      cb.checked = BUILTIN_TOOLS[name] !== false;
      cb.onchange = () => {
        BUILTIN_TOOLS[name] = cb.checked;
        localStorage.setItem('builtin_tools', JSON.stringify(BUILTIN_TOOLS));
      };

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;';
      info.innerHTML =
        `<span style="font-weight:600;">${name}</span>` +
        (bt.displayName ? `<br><span style="font-size:0.8em;color:var(--text2);">${_esc(bt.displayName)}</span>` : '');

      const editBtn = _btn('Edit');
      editBtn.onclick = () => {
        const existing = list.querySelector(`.memory-tool-config[data-for="${name}"]`);
        if (existing) { existing.remove(); return; }
        // Close any other open panel first, so at most one drawer is open
        // at a time and it always sits right under the row that opened it.
        list.querySelectorAll('.memory-tool-config').forEach(el => el.remove());
        row.insertAdjacentElement('afterend', _buildMemoryToolConfigPanel(name, cfg));
      };

      row.append(cb, info, editBtn);
      list.appendChild(row);
    }
  }

  function _buildMemoryToolConfigPanel(name, cfg) {
    const panel = document.createElement('div');
    panel.className = 'memory-tool-config';
    panel.dataset.for = name;
    panel.style.cssText =
      'padding:8px 9px;margin:-2px 0 6px;border:1px solid var(--border);border-top:none;' +
      'border-radius:0 0 5px 5px;background:var(--bg);font-size:0.84em;';

    const label = document.createElement('div');
    label.style.cssText = 'color:var(--text2);font-size:0.82em;margin-bottom:4px;';
    label.textContent = 'Description sent to the model';
    panel.appendChild(label);

    const descTa = _ta(cfg.get(), '', 6);
    panel.appendChild(descTa);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;';

    const resetBtn = _btn('Reset to default');
    resetBtn.onclick = () => { descTa.value = cfg.def(); };

    const saveBtn = _btn('Save', 'background:var(--accent);');
    saveBtn.onclick = () => {
      const val = descTa.value.trim() || cfg.def();
      cfg.set(val);
      localStorage.setItem(cfg.key, val);
      _panelStatus(panel, 'Saved.', 'var(--green)');
    };

    btnRow.append(resetBtn, saveBtn);
    panel.appendChild(btnRow);

    return panel;
  }

  renderMemoryToolsList();

  // ── Entries list (filter + lazy-load) ───────────────────────────────
  let _entriesCache = [];   // full set, always loaded in full — filtering needs it all
  let _visibleCount  = ENTRIES_PAGE_SIZE;
  let _filterQuery   = '';

  function _matchesFilter(entry, q) {
    if (!q) return true;
    const hay = (entry.text + ' ' + (entry.tags || []).join(' ')).toLowerCase();
    return hay.includes(q);
  }

  function _renderEntries() {
    const list       = document.getElementById('memory-entries-list');
    const countEl     = document.getElementById('memory-entries-count');
    const loadMoreWrap = document.getElementById('memory-load-more-wrap');
    if (!list) return;

    const filtered = _filterQuery
      ? _entriesCache.filter(e => _matchesFilter(e, _filterQuery))
      : _entriesCache;

    if (countEl) {
      countEl.textContent = _entriesCache.length
        ? (_filterQuery ? `(${filtered.length} of ${_entriesCache.length})` : `(${_entriesCache.length})`)
        : '';
    }

    if (!_entriesCache.length) {
      list.innerHTML = `<div style="font-size:0.82em;color:var(--text-dim);padding:8px 0;">No memories saved yet.</div>`;
      loadMoreWrap.innerHTML = '';
      return;
    }
    if (_filterQuery && !filtered.length) {
      list.innerHTML = `<div style="font-size:0.82em;color:var(--text-dim);padding:8px 0;">No memories match "${_esc(_filterQuery)}".</div>`;
      loadMoreWrap.innerHTML = '';
      return;
    }

    // Filter active → show every match (searches the full set, not just the
    // loaded page). No filter → lazy-load in batches of ENTRIES_PAGE_SIZE.
    const toShow = _filterQuery ? filtered : filtered.slice(0, _visibleCount);

    list.innerHTML = '';
    for (const entry of toShow) {
      const row = document.createElement('div');
      row.style.cssText =
        'padding:8px 9px;margin-bottom:6px;border:1px solid var(--border);border-radius:6px;' +
        'background:var(--bg2);font-size:0.84em;';
      row.dataset.entryId = entry.id;

      const tagsHtml = (entry.tags || []).map(t =>
        `<span style="font-size:10px;padding:1px 6px;border-radius:10px;background:var(--bg3,var(--surface));color:var(--text-dim);">${_esc(t)}</span>`
      ).join(' ');

      row.innerHTML = `
        <div class="memory-entry-view">
          <div style="white-space:pre-wrap;word-break:break-word;line-height:1.4;">${_esc(entry.text)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-top:6px;">
            ${tagsHtml}
            <span style="font-size:10px;color:var(--text-dim);margin-left:auto;">
              ${entry.confidence === 'inferred' ? 'inferred · ' : ''}${_fmtDate(entry.updated || entry.created)}
            </span>
          </div>
          <div style="display:flex;gap:6px;margin-top:7px;">
            <button class="settings-row-btn memory-edit-btn">Edit</button>
            <button class="settings-row-btn danger memory-delete-btn">Delete</button>
          </div>
        </div>`;

      row.querySelector('.memory-edit-btn').addEventListener('click', () => _showEditForm(row, entry));
      row.querySelector('.memory-delete-btn').addEventListener('click', () => _deleteEntry(row, entry));

      list.appendChild(row);
    }

    // "Load more" only makes sense with no active filter (filter already
    // shows everything that matches).
    loadMoreWrap.innerHTML = '';
    if (!_filterQuery && filtered.length > _visibleCount) {
      const moreBtn = _btn(`Load more (${filtered.length - _visibleCount} remaining)`);
      moreBtn.onclick = () => {
        _visibleCount += ENTRIES_PAGE_SIZE;
        _renderEntries();
      };
      loadMoreWrap.appendChild(moreBtn);
    }
  }

  function _showEditForm(row, entry) {
    const view = row.querySelector('.memory-entry-view');
    const wrap = document.createElement('div');
    wrap.className = 'memory-entry-edit';

    const textArea = _ta(entry.text, '', 3);

    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.value = (entry.tags || []).join(', ');
    tagsInput.placeholder = 'tags, comma, separated';
    tagsInput.style.cssText = INPUT_STYLE + 'margin-top:6px;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:7px;';
    const saveBtn = _btn('Save', 'background:var(--accent);');
    const cancelBtn = _btn('Cancel');

    saveBtn.addEventListener('click', async () => {
      const newText = textArea.value.trim();
      if (!newText) return;
      const newTags = tagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await updateMemoryEntry(entry.id, { text: newText, tags: newTags });
        entry.text = newText;
        entry.tags = newTags;
        entry.updated = new Date().toISOString();
        _status('Memory updated.', 'var(--green)');
        _renderEntries();
      } catch (e) {
        _status(`Failed to update: ${e.message}`, 'var(--red)');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });
    cancelBtn.addEventListener('click', () => _renderEntries());

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);
    wrap.appendChild(textArea);
    wrap.appendChild(tagsInput);
    wrap.appendChild(btnRow);

    view.replaceWith(wrap);
    textArea.focus();
  }

  async function _deleteEntry(row, entry) {
    if (!confirm('Delete this memory permanently? This cannot be undone.')) return;
    try {
      await deleteMemoryEntry(entry.id);
      _entriesCache = _entriesCache.filter(e => e.id !== entry.id);
      _status('Memory deleted.', 'var(--green)');
      _renderEntries();
    } catch (e) {
      _status(`Failed to delete: ${e.message}`, 'var(--red)');
    }
  }

  async function refreshMemoryEntries() {
    if (typeof fetchMemoryList !== 'function') {
      _status('Memory module unavailable (memory.js not loaded).', 'var(--red)');
      return;
    }
    _status('Loading…');
    try {
      const data = await fetchMemoryList();
      _entriesCache = data.entries || [];
      _visibleCount = ENTRIES_PAGE_SIZE;
      _status('');
      _renderEntries();
    } catch (e) {
      _status(`Failed to load memories: ${e.message}`, 'var(--red)');
    }
  }

  // ── Filter input ─────────────────────────────────────────────
  const filterInput = document.getElementById('memory-filter-input');
  if (filterInput) {
    let _filterDebounce = null;
    filterInput.addEventListener('input', () => {
      clearTimeout(_filterDebounce);
      _filterDebounce = setTimeout(() => {
        _filterQuery = filterInput.value.trim().toLowerCase();
        _renderEntries();
      }, 120);
    });
  }

  document.getElementById('memory-refresh-btn')?.addEventListener('click', refreshMemoryEntries);

  document.getElementById('memory-reindex-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('memory-reindex-btn');
    btn.disabled = true;
    btn.textContent = 'Reindexing…';
    try {
      const resp = await fetch('/api/memory/reindex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-ID': (typeof getEffectiveClientId === 'function' ? getEffectiveClientId() : (typeof CLIENT_ID !== 'undefined' ? CLIENT_ID : 'anonymous')) },
        body: JSON.stringify({
          embed_model: RAG_EMBED_MODEL, embed_flavor: RAG_EMBED_FLAVOR,
          ollama_base: OLLAMA_BASE, qdrant_url: RAG_QDRANT_URL,
        }),
      });
      const data = await resp.json();
      _status(resp.ok ? `Reindexed ${data.reindexed ?? 0} entries.` : `Reindex failed: ${data.detail || resp.status}`,
               resp.ok ? 'var(--green)' : 'var(--red)');
    } catch (e) {
      _status(`Reindex failed: ${e.message}`, 'var(--red)');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Reindex';
    }
  });

  // Refresh the list whenever the Memory nav item is opened, same pattern
  // used for the Prompts section above.
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    if (btn.dataset.section === 'memory') {
      btn.addEventListener('click', refreshMemoryEntries);
    }
  });

  window.refreshMemoryEntries = refreshMemoryEntries;

})();

loadSettingsUI();
applyChatWidth(CHAT_WIDTH);
checkOllama();

// ── Cloudflare Access logout ───────────────────────────────────
// Revokes the session across ALL apps under this Zero Trust team in one
// click — Cloudflare doesn't support a true per-app logout (only
// team-wide), so this also logs you out of ollama.rubyrinth.xyz, not just
// this app. `redirect_url` is a widely-used but undocumented param; if
// Cloudflare ignores it you just land on its own logout confirmation page
// instead of being bounced back here — harmless either way.
document.getElementById('cf-logout-btn')?.addEventListener('click', () => {
  const back = encodeURIComponent(window.location.origin + window.location.pathname);
  window.location.href = `https://${CF_ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/logout?redirect_url=${back}`;
});
