// ══ MAIN.JS ══════════════════════════════════════════════════
// Shared runtime state, DOM refs, appearance helpers, mode
// routing, API-status polling, and app initialisation.
//
// Load order in index.html:
//   config.js → api.js → ollama.js → lmstudio.js → openai.js
//   → main.js (this file)
//   → search.js → settings.js → corrector.js → chat.js
//   → image.js → backend.js → status-panel.js

// ── Backend mode ──────────────────────────────────────────────
// true when served via nginx + Python backend (not file://)
let BACKEND_AVAILABLE = false;
let _sseSource = null;

// Whether to route chat turns through the backend server.
// Can be toggled at runtime via the model-bar button even when
// BACKEND_AVAILABLE is true, so tool calling can be used locally.
// Persisted to localStorage under 'jarvis_use_backend_chat'.
let USE_BACKEND_CHAT = (() => {
  const saved = localStorage.getItem('jarvis_use_backend_chat');
  // Default ON when backend is available (preserves existing behaviour);
  // the user can flip it off at any time via the toggle button.
  return saved === null ? true : saved === 'true';
})();

// crypto.randomUUID() only exists in secure contexts (https, or
// http://localhost) — accessing this app over plain HTTP on a LAN IP
// (e.g. http://10.x.x.x:8090) is NOT a secure context, so the browser
// leaves crypto.randomUUID undefined there. Calling it unguarded threw an
// uncaught TypeError at global scope, which halted the rest of this
// script — meaning CLIENT_ID (and everything below it) never got
// initialized, cascading into "Cannot access 'X' before initialization"
// errors in every other file that loads after main.js. Same fallback
// pattern used in memory.js's _uuidv4() for the same reason.
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

// Stable per-browser UUID — survives page close, works behind any proxy.
const CLIENT_ID = (() => {
  let id = localStorage.getItem('_jarvis_client_id');
  if (!id) { id = _uuidv4(); localStorage.setItem('_jarvis_client_id', id); }
  return id;
})();

// Returns the Client ID that should be used for all backend job requests.
// When the user has set an override in Settings → Server, that value is used
// instead of the auto-generated CLIENT_ID, allowing multiple instances to
// share the same job queue.
function getEffectiveClientId() {
  return (typeof BACKEND_CLIENT_ID_OVERRIDE !== 'undefined' && BACKEND_CLIENT_ID_OVERRIDE.trim())
    ? BACKEND_CLIENT_ID_OVERRIDE.trim()
    : CLIENT_ID;
}

// Common headers to attach to every backend request
function backendHeaders() {
  return { 'Content-Type': 'application/json', 'X-Client-ID': getEffectiveClientId() };
}

// ── Appearance helpers ────────────────────────────────────────
function applyTheme(theme) {
  APP_THEME = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const darkBtn  = document.getElementById('theme-dark-btn');
  const lightBtn = document.getElementById('theme-light-btn');
  if (darkBtn)  darkBtn.classList.toggle('active',  theme === 'dark');
  if (lightBtn) lightBtn.classList.toggle('active', theme === 'light');
}

function applyFontSize(size) {
  APP_FONT_SIZE = size;
  document.documentElement.style.setProperty('--font-size-base', size + 'px');
  // --font-size-input is clamped to ≥16px so iOS Safari never zooms on focus.
  document.documentElement.style.setProperty('--font-size-input', Math.max(16, size) + 'px');
  const label = document.getElementById('font-size-label');
  if (label) label.textContent = size + 'px';
  const slider = document.getElementById('set-font-size');
  if (slider) slider.value = size;
}

function applyAccent(color) {
  APP_ACCENT = color;
  document.documentElement.style.setProperty('--accent', color);
  const picker = document.getElementById('set-accent-color');
  if (picker) picker.value = color;
}

// ── Image API Mode ─────────────────────────────────────────────
function setImgApiMode(mode) {
  IMG_API_MODE = mode;
  // Show/hide seed + steps (only available in Native Ollama mode)
  const nativeOpts = document.getElementById('img-native-opts');
  if (nativeOpts) nativeOpts.style.display = mode === 'native' ? '' : 'none';
  // Sync the image API flavour selector to match the chosen generation mode.
  const flavorSel = document.getElementById('set-img-api-flavor');
  if (flavorSel) {
    const suggested = mode === 'native' ? 'ollama' : 'openai';
    flavorSel.value = suggested;
    IMG_API_FLAVOR  = suggested;
  }
}

// Apply on load
applyTheme(APP_THEME);
applyFontSize(APP_FONT_SIZE);
applyAccent(APP_ACCENT);
// IMG_API_MODE UI applied after DOM is ready (inside the init IIFE below)

// ── URL param overrides ───────────────────────────────────────
// Session-only, never written to localStorage
const _urlParams = new URLSearchParams(window.location.search);
const URL_OVERRIDES = {};
if (_urlParams.has('temp'))           URL_OVERRIDES.temperature   = parseFloat(_urlParams.get('temp'));
if (_urlParams.has('ctx'))            URL_OVERRIDES.num_ctx        = parseInt(_urlParams.get('ctx'));
if (_urlParams.has('top_p'))          URL_OVERRIDES.top_p          = parseFloat(_urlParams.get('top_p'));
if (_urlParams.has('top_k'))          URL_OVERRIDES.top_k          = parseInt(_urlParams.get('top_k'));
if (_urlParams.has('repeat_penalty')) URL_OVERRIDES.repeat_penalty = parseFloat(_urlParams.get('repeat_penalty'));

// Runtime options actually sent to the model (localStorage + URL overrides merged)
let RUNTIME_OPTIONS = { ...ADV_OPTIONS, ...URL_OVERRIDES };

// URL think override — null means "not set via URL"
const URL_THINK = _urlParams.has('think')
  ? (_urlParams.get('think') === 'true' || _urlParams.get('think') === '1')
  : null;

// Persisted think & last model
const SAVED_THINK = localStorage.getItem('ollama_think') === 'true';
const LAST_MODEL  = localStorage.getItem('ollama_last_model') || null;

// URL model override — session-only, never written to localStorage
const URL_MODEL = _urlParams.get('model') || null;

// ── Shared DOM refs ───────────────────────────────────────────
// Used across multiple feature files and flavor files — must stay here.
const modelSel    = document.getElementById('model-select');
const statusDot   = document.getElementById('status-dot');
const statusText  = document.getElementById('status-text');
const thinkToggle = document.getElementById('think-toggle');
const thinkLabel  = document.getElementById('think-label');

// ── Runtime state ─────────────────────────────────────────────
let loadedModelName = null;
let currentAbortController = null;

// Initialise think toggle: URL param wins for this session, otherwise use localStorage
thinkToggle.checked = URL_THINK !== null ? URL_THINK : SAVED_THINK;

// Persist manual toggles to localStorage (does not affect URL-based sessions)
function updateThinkLabel() {
  if (thinkLabel) thinkLabel.classList.toggle('think-active', thinkToggle.checked);
}
thinkToggle.addEventListener('change', () => {
  localStorage.setItem('ollama_think', thinkToggle.checked);
  updateThinkLabel();
});
updateThinkLabel();

// Persist model selection to localStorage and update capability-driven UI
modelSel.addEventListener('change', () => {
  localStorage.setItem('ollama_last_model', modelSel.value);
  updateThinkToggle();
  updateChatAttachBtn();
});

// ── Mobile detection ─────────────────────────────────────────
function isMobile() {
  if (/Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) return true;
  if (window.innerWidth <= 600 && window.matchMedia('(pointer: coarse)').matches) return true;
  return false;
}

// ── Model capabilities cache ──────────────────────────────────
// Must be declared before setMode() / the init IIFE so the const is
// not in the temporal dead zone when updateThinkToggle() is first called.
// Maps model name → Set<string> of capabilities reported by /api/show.
const modelCaps = new Map();

async function fetchModelCaps(name) {
  if (modelCaps.has(name)) return modelCaps.get(name);
  try {
    const caps = await API.modelCaps(name);
    modelCaps.set(name, caps);
    return caps;
  } catch {
    modelCaps.set(name, new Set());
    return new Set();
  }
}

// Show / hide the Think toggle based on the currently selected chat/corrector model.
// When hidden, also force the toggle OFF so the think param is never sent to a
// model that doesn't support it (the user can't reach a hidden checkbox to fix it).
function updateThinkToggle() {
  if (currentMode === 'image') return;
  const caps = modelCaps.get(modelSel.value) || new Set();
  const hasThinking = caps.has('thinking');
  const thinkWrap = document.querySelector('.think-toggle-wrap');
  if (thinkWrap) thinkWrap.style.display = hasThinking ? '' : 'none';
  if (!hasThinking && thinkToggle.checked) {
    thinkToggle.checked = false;
    localStorage.setItem('ollama_think', 'false');
    updateThinkLabel();
  }
}

// Always show the attach button — text files work with any model.
// Clear any media attachment if the new model lacks that capability.
function updateChatAttachBtn() {
  const caps = modelCaps.get(modelSel.value) || new Set();
  const btn = document.getElementById('chat-attach-btn');
  if (btn) btn.classList.remove('hidden');
  if (chatAttachedType === 'image' && !caps.has('vision')) clearChatAttachment();
  if (chatAttachedType === 'audio' && !caps.has('audio'))  clearChatAttachment();
}

// ── Mode routing ──────────────────────────────────────────────
let currentMode = 'corrector';

function updateHeader(mode) {
  const iconWrap  = document.getElementById('header-icon-wrap');
  const mainTitle = document.getElementById('main-title');
  const headerTag = document.getElementById('header-tag');

  if (mode === 'corrector') {
    iconWrap.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2L4 5.5V11C4 15.418 7.582 19.632 12 21C16.418 19.632 20 15.418 20 11V5.5L12 2Z" fill="oklch(from var(--green) l c h / 15%)" stroke="var(--green)" stroke-width="1.5" stroke-linejoin="round"/><path d="M8.5 12L10.5 14L15.5 9.5" stroke="var(--green)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    mainTitle.textContent = 'Local Text Corrector';
    const _flavLabels = { ollama: 'Ollama', lmstudio: 'LM Studio', openai: 'OpenAI' };
    headerTag.textContent = _flavLabels[API_FLAVOR] || 'API';
  } else if (mode === 'chat') {
    iconWrap.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    mainTitle.textContent = 'AI Chat Assistant';
    headerTag.textContent = 'Amarinth UI';
  } else if (mode === 'image') {
    iconWrap.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;
    mainTitle.textContent = 'Image Generator';
    headerTag.textContent = 'Diffusion';
  } else if (mode === 'rag') {
    iconWrap.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>`;
    mainTitle.textContent = 'RAG Knowledge Base';
    headerTag.textContent = 'Qdrant';
  }
}

function setMode(mode) {
  if (mode !== 'corrector' && mode !== 'chat' && mode !== 'image' && mode !== 'rag') mode = 'corrector';
  currentMode = mode;

  const url = new URL(window.location);
  url.searchParams.set('mode', mode);
  window.history.replaceState({}, '', url);

  document.getElementById('corrector-mode').classList.toggle('hidden', mode !== 'corrector');
  document.getElementById('chat-mode').classList.toggle('hidden', mode !== 'chat');
  document.getElementById('image-mode').classList.toggle('hidden', mode !== 'image');
  document.getElementById('rag-mode')?.classList.toggle('hidden', mode !== 'rag');

  document.getElementById('btn-mode-corrector').classList.toggle('active', mode === 'corrector');
  document.getElementById('btn-mode-chat').classList.toggle('active', mode === 'chat');
  document.getElementById('btn-mode-image').classList.toggle('active', mode === 'image');
  document.getElementById('btn-mode-rag')?.classList.toggle('active', mode === 'rag');

  // Hide think + tool-header controls in image mode (not applicable)
  const thinkWrap       = document.querySelector('.think-toggle-wrap');
  const toolHeaderBtns  = document.getElementById('tool-header-buttons');
  const modelLabel      = document.querySelector('.model-bar > label');
  const modelSelEl      = document.getElementById('model-select');
  const imgModelBarOpts = document.getElementById('img-model-bar-opts');
  if (mode === 'image' || mode === 'rag') {
    if (thinkWrap)      thinkWrap.style.display      = 'none';
    if (toolHeaderBtns) toolHeaderBtns.style.display = 'none';
    if (modelLabel)     modelLabel.style.display     = 'none';
    if (modelSelEl)     modelSelEl.style.display     = 'none';
    imgModelBarOpts?.classList.add('hidden');
    if (mode === 'image') imgModelBarOpts?.classList.remove('hidden');
  } else {
    updateThinkToggle();
    if (toolHeaderBtns) {
      toolHeaderBtns.style.display = mode === 'chat' ? '' : 'none';
      if (mode === 'chat') renderToolHeaderButtons();
    }
    if (modelLabel) modelLabel.style.display  = '';
    if (modelSelEl) modelSelEl.style.display  = '';
    imgModelBarOpts?.classList.add('hidden');
  }

  // Show the clear/export/import chat icons in model-bar only in chat mode
  ['chat-clear-btn', 'chat-export-btn', 'chat-import-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', mode !== 'chat');
  });

  // Show the system-prompt selector in the model-bar only in chat mode
  const syspromptWrap = document.getElementById('sysprompt-select-wrap');
  if (syspromptWrap) syspromptWrap.style.display = (mode === 'chat') ? 'flex' : 'none';

  // Show the RAG collection picker in chat mode only
  const ragCollectionWrap = document.getElementById('rag-collection-wrap');
  if (ragCollectionWrap) ragCollectionWrap.style.display = (mode === 'chat') ? 'flex' : 'none';

  updateHeader(mode);

  // On desktop: focus the primary input so the user can start typing immediately.
  // On mobile: skip — it would pop up the virtual keyboard.
  // Guard with typeof: these vars are declared in corrector.js / chat.js which
  // load AFTER main.js, so they don't exist yet when the init IIFE calls setMode().
  if (!isMobile()) {
    if      (mode === 'corrector' && typeof inputEl   !== 'undefined') inputEl?.focus();
    else if (mode === 'chat'      && typeof chatInput !== 'undefined') chatInput?.focus();
    else if (mode === 'image') document.getElementById('img-prompt')?.focus();
  }
  if (mode === 'chat' && typeof chatMessagesEl !== 'undefined' && chatMessagesEl)
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

// ── Settings UI loader ────────────────────────────────────────
// Kept here (not in settings.js) because it is called from the
// init IIFE below — before settings.js has been parsed.
function loadSettingsUI() {
  setApiUrl.value = OLLAMA_BASE;
  const flavorSel = document.getElementById('set-api-flavor');
  if (flavorSel) flavorSel.value = API_FLAVOR;
  setTemp.value     = ADV_OPTIONS.temperature;
  setCtx.value      = ADV_OPTIONS.num_ctx;
  setTopP.value     = ADV_OPTIONS.top_p;
  if (setTopK) setTopK.value = (ADV_OPTIONS.top_k != null) ? ADV_OPTIONS.top_k : '';
  setRepPen.value   = ADV_OPTIONS.repeat_penalty;
  const _nbEl = document.getElementById('set-num-batch');
  if (_nbEl) _nbEl.value = (ADV_OPTIONS.num_batch != null) ? ADV_OPTIONS.num_batch : '';

  setCorrectorSystem.value = CORRECTOR_SYSTEM;
  // Chat system prompts are managed by the prompts section in settings.js
  if (typeof renderChatPromptsUI === 'function') renderChatPromptsUI();

  // Brave Search
  setBraveProxy.value   = BRAVE_PROXY_URL;
  setBraveResults.value = BRAVE_RESULTS;

  // Appearance
  applyTheme(APP_THEME);
  applyFontSize(APP_FONT_SIZE);
  applyAccent(APP_ACCENT);

  // RAG / Qdrant settings
  const _setQdrantUrl = document.getElementById('set-qdrant-url');
  if (_setQdrantUrl) _setQdrantUrl.value = RAG_QDRANT_URL;
  const _setRagEmbedModel = document.getElementById('set-rag-embed-model');
  if (_setRagEmbedModel) _setRagEmbedModel.value = RAG_EMBED_MODEL;
  const _setRagEmbedFlavor = document.getElementById('set-rag-embed-flavor');
  if (_setRagEmbedFlavor) _setRagEmbedFlavor.value = RAG_EMBED_FLAVOR;
  const _setRagTopK = document.getElementById('set-rag-top-k');
  if (_setRagTopK) _setRagTopK.value = RAG_TOP_K;

  // Image API mode
  setImgApiMode(IMG_API_MODE);
  if (setImgApiUrl)    setImgApiUrl.value    = IMG_API_BASE;
  if (setImgApiFlavor) setImgApiFlavor.value = IMG_API_FLAVOR;

  // Server Client ID override
  const setClientIdOverride = document.getElementById('set-client-id-override');
  if (setClientIdOverride) {
    setClientIdOverride.value       = BACKEND_CLIENT_ID_OVERRIDE;
    setClientIdOverride.placeholder = CLIENT_ID;
  }

  // Stats display
  const showStatsEl = document.getElementById('set-show-stats');
  if (showStatsEl) showStatsEl.checked = SHOW_STATS;

  // Show a hint in the title if any URL overrides are active
  const overriddenKeys = Object.keys(URL_OVERRIDES);
  const allOverrides = [...overriddenKeys.map(k => ({ temperature: 'temp', num_ctx: 'ctx', top_p: 'top_p', repeat_penalty: 'repeat_penalty' }[k] || k))];
  if (URL_MODEL)        allOverrides.push('model');
  if (URL_THINK !== null) allOverrides.push('think');
  const modalTitle = document.querySelector('#settings-modal .pane-title');
  if (modalTitle) {
    if (allOverrides.length > 0) {
      modalTitle.innerHTML = `Advanced Settings <span style="font-size:9px;color:var(--accent);margin-left:8px;letter-spacing:0.5px;">URL override active: ${allOverrides.join(', ')}</span>`;
    } else {
      modalTitle.textContent = 'Advanced Settings';
    }
  }
}

// ── Ollama / API status ───────────────────────────────────────
// Declared BEFORE the init IIFE so it is always initialized, even if
// setMode() throws due to corrector.js / chat.js not yet being loaded.
// checkOllama() is async — a TDZ hit there becomes a silent rejected
// promise, which is exactly why the model selector was never populating.
let modelListPopulated = false;

// ── Init from URL ─────────────────────────────────────────────
// NOTE: loadSettingsUI() is intentionally NOT called here.
// It references DOM refs declared in settings.js (setApiUrl, setTemp, …),
// which hasn't been parsed yet at this point in the load order.
// settings.js calls loadSettingsUI() itself at the bottom of its file,
// after all its own refs are defined.
(function() {
  const p = new URLSearchParams(window.location.search);
  setMode(p.get('mode') || 'chat');
  // Apply persisted image API mode now that the DOM is ready
  setImgApiMode(IMG_API_MODE);
  // Initial focus on desktop is handled at the bottom of corrector.js and
  // chat.js respectively — those files own the inputEl / chatInput refs.
})();

async function checkOllama() {
  try {
    const allModels = await API.listModels();
    statusDot.className = 'status-dot online';
    statusText.textContent = 'Ready';

    if (allModels && allModels.length) {
      let textModels, imageModels;

      if (API.isOllama()) {
        // Fetch capabilities for every model in parallel (cached after first call)
        await Promise.all(allModels.map(m => fetchModelCaps(m.name)));
        // Split: text models go to chat/corrector selector; image models go to image selector.
        textModels  = allModels.filter(m => {
          const caps = modelCaps.get(m.name) || new Set();
          return caps.has('completion') || caps.size === 0;
        });
        imageModels = allModels.filter(m => {
          const caps = modelCaps.get(m.name) || new Set();
          return caps.has('image');
        });
      } else {
        // OpenAI-compat / LM Studio: use cached caps from listModels() if available
        textModels  = allModels;
        imageModels = [];
        allModels.forEach(m => {
          modelCaps.set(m.name, API._lmsCapsCache.get(m.name) || new Set(['completion']));
        });
      }

      // ── Chat / corrector model selector ──
      const prevVal = modelListPopulated ? modelSel.value : null;
      modelSel.innerHTML = '';
      textModels.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.name.replace(/:latest$/, '');
        modelSel.appendChild(opt);
      });

      const available = new Set([...modelSel.options].map(o => o.value));
      const preferred = [URL_MODEL, prevVal, LAST_MODEL].find(v => v && available.has(v));
      if (preferred) modelSel.value = preferred;
      if (URL_MODEL && !available.has(URL_MODEL)) {
        statusText.textContent = `Ollama running — model "${URL_MODEL}" not found`;
      }

      modelListPopulated = true;

      // Update UI toggles to reflect the selected model's capabilities
      updateThinkToggle();
      updateChatAttachBtn();
    }

    // ── Image model selector (populated separately via listImgModels) ──
    // Runs outside the allModels guard: the image API is independent of the
    // text API, so we refresh it whenever the text API responds.
    listImgModels();
  } catch {
    statusDot.className = 'status-dot error';
    statusText.textContent = `${API.isOllama() ? 'Ollama' : 'API'} not reachable at ${OLLAMA_BASE}`;
  }
}
checkOllama();

// ── Image model listing ───────────────────────────────────────
// Runs independently from checkOllama() — a different server and API
// flavour can be used for image generation without affecting text mode.
async function listImgModels() {
  if (!imgModelSel) return;
  const imgBase = (IMG_API_BASE || OLLAMA_BASE).replace(/\/$/, '');
  try {
    const imageModels = IMG_API_FLAVOR === 'ollama'
      ? await OllamaAPI.listImgModels(imgBase)
      : await OpenAIAPI.listImgModels(imgBase);

    imgModelSel.innerHTML = '';
    if (imageModels.length) {
      imageModels.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.name.replace(/:latest$/, '').split('/').pop();
        imgModelSel.appendChild(opt);
      });
      const lastImgModel = localStorage.getItem('img_last_model');
      const available = new Set([...imgModelSel.options].map(o => o.value));
      if (lastImgModel && available.has(lastImgModel)) imgModelSel.value = lastImgModel;
    } else {
      const placeholder = document.createElement('option');
      placeholder.value = ''; placeholder.disabled = true; placeholder.selected = true;
      placeholder.textContent = 'No image models found';
      imgModelSel.appendChild(placeholder);
    }
  } catch (e) {
    imgModelSel.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.disabled = true; placeholder.selected = true;
    placeholder.textContent = `Image API unreachable: ${e.message}`;
    imgModelSel.appendChild(placeholder);
  }
}

// ── Model Management ──────────────────────────────────────────
async function ensureModelLoaded() {
  const targetModel = modelSel.value;
  if (loadedModelName && loadedModelName !== targetModel) {
    console.log(`Unloading ${loadedModelName} to make room for ${targetModel}`);
    try { await API.unloadModel(loadedModelName); }
    catch (e) { console.warn('Failed to stop previous model', e); }
  }
  loadedModelName = targetModel;
}

// ── Tool header buttons ───────────────────────────────────────
// Renders per-HTTP-tool toggle buttons into #tool-header-buttons.
// Only called when entering chat mode; container is hidden in other modes.
// Each HTTP tool with headerPin:true gets one button using its icon SVG.
// Clicking the button toggles tool.enabled and persists to localStorage.
(function _injectToolBtnStyles() {
  if (document.getElementById('_tool-btn-styles')) return;
  const s = document.createElement('style');
  s.id = '_tool-btn-styles';
  s.textContent = `
    #tool-header-buttons { display:flex; align-items:center; gap:2px; }
    .tool-header-btn {
      display:flex; align-items:center; justify-content:center;
      width:24px; height:24px; border-radius:5px; cursor:pointer;
      border:1px solid transparent; color:var(--text2);
      transition:color 0.15s, border-color 0.15s, background 0.15s;
    }
    .tool-header-btn svg { pointer-events:none; }
    .tool-header-btn:hover { color:var(--text); border-color:var(--border); }
    .tool-header-btn.tool-btn-active {
      color:var(--accent); border-color:var(--accent);
      background:oklch(from var(--accent) l c h / 10%);
    }
  `;
  document.head.appendChild(s);
})();

function renderToolHeaderButtons() {
  const container = document.getElementById('tool-header-buttons');
  if (!container) return;
  container.innerHTML = '';
  if (typeof TOOLS_ENABLED === 'undefined') return;
  if (typeof TOOLS_CONFIG === 'undefined') return;

  // ── Master tools toggle ──────────────────────────────────────
  // Mirrors the "Enable" checkbox in Settings → Tool Calling.
  // Always rendered (regardless of TOOLS_ENABLED) so the user can
  // switch tools on/off without opening the settings panel.
  const TOOLS_ICON =
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
    ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77` +
    `a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91` +
    `a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;

  const masterBtn = document.createElement('label');
  masterBtn.className = 'tool-header-btn' + (TOOLS_ENABLED ? ' tool-btn-active' : '');
  masterBtn.title = TOOLS_ENABLED ? 'Tools enabled — click to disable' : 'Tools disabled — click to enable';

  const masterCb = document.createElement('input');
  masterCb.type = 'checkbox';
  masterCb.checked = !!TOOLS_ENABLED;
  masterCb.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:0;height:0;';
  masterCb.addEventListener('change', () => {
    TOOLS_ENABLED = masterCb.checked;
    localStorage.setItem('tools_enabled', TOOLS_ENABLED);
    masterBtn.classList.toggle('tool-btn-active', TOOLS_ENABLED);
    masterBtn.title = TOOLS_ENABLED ? 'Tools enabled — click to disable' : 'Tools disabled — click to enable';
    // Sync the checkbox in the settings panel if it is open
    const settingsCb = document.getElementById('set-tools-enabled');
    if (settingsCb) settingsCb.checked = TOOLS_ENABLED;
    // Re-render per-tool pin buttons (they only show when tools are enabled)
    renderToolHeaderButtons();
  });

  const iconTemplate = document.createElement('template');
  iconTemplate.innerHTML = TOOLS_ICON;
  const iconEl = iconTemplate.content.querySelector('svg');

  masterBtn.appendChild(masterCb);
  if (iconEl) masterBtn.appendChild(iconEl);
  container.appendChild(masterBtn);

  // Per-tool pin buttons only visible when tools are globally enabled
  if (!TOOLS_ENABLED) return;

  const FALLBACK_ICON =
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
    ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77` +
    `a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91` +
    `a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;

  for (const tool of TOOLS_CONFIG) {
    if (tool.type !== 'http' || !tool.headerPin) continue;

    const btn = document.createElement('label');
    btn.className = 'tool-header-btn' + (tool.enabled !== false ? ' tool-btn-active' : '');
    btn.title = (tool.description || tool.name) +
                (tool.enabled !== false ? ' (active — click to disable)' : ' (disabled — click to enable)');

    // Hidden checkbox drives the toggle
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = tool.enabled !== false;
    cb.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:0;height:0;';
    cb.addEventListener('change', () => {
      tool.enabled = cb.checked;
      localStorage.setItem('tools_config', JSON.stringify(TOOLS_CONFIG));
      btn.classList.toggle('tool-btn-active', tool.enabled);
      btn.title = (tool.description || tool.name) +
                  (tool.enabled ? ' (active — click to disable)' : ' (disabled — click to enable)');
    });

    // Icon: parse raw SVG string directly, otherwise use fallback
   const rawIcon = (tool.icon || '').trim();
   let iconEl;

   if (rawIcon.startsWith('<')) {
     const template = document.createElement('template');
     template.innerHTML = rawIcon;
     iconEl = template.content.querySelector('svg');
     
     // Normalise size so icons stay consistent regardless of source SVG dimensions
     if (iconEl) { 
       iconEl.setAttribute('width', '16'); 
       iconEl.setAttribute('height', '16'); 
     }
   }

   // If parsing failed or it wasn't a valid SVG string, fall back
   if (!iconEl) {
     const template = document.createElement('template');
     template.innerHTML = FALLBACK_ICON;
     iconEl = template.content.querySelector('svg');
   }

   btn.appendChild(cb);
   if (iconEl) btn.appendChild(iconEl); // Appends the SVG directly, no span required
   container.appendChild(btn);
  }
}

// ── Global shortcuts ──────────────────────────────────────────
// Ctrl/Cmd+Alt+F5..F8 → switch mode (Corrector, Chat, Image, RAG).
// Fires regardless of focus (including inside text inputs), since this
// modifier combo won't collide with normal typing.
const _MODE_SHORTCUT_KEYS = {
  F5: 'corrector',
  F6: 'chat',
  F7: 'image',
  F8: 'rag',
};
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.altKey && _MODE_SHORTCUT_KEYS[e.code]) {
    e.preventDefault();
    setMode(_MODE_SHORTCUT_KEYS[e.code]);
  }
});

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space') {
    e.preventDefault();
    if (currentMode === 'corrector') correct();
    else if (currentMode === 'chat') sendChat();
    else if (currentMode === 'image') generateImage();
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyD') {
    e.preventDefault();
    if (currentMode === 'corrector') clearBtn.click();
    else if (currentMode === 'chat') clearChat();
    else if (currentMode === 'image') imgClearBtn?.click();
  }
});
