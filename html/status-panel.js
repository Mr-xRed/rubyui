// ══ STATUS-PANEL.JS ══════════════════════════════════════════
// Model status panel: running/available model lists, VRAM/RAM
// display, server info, image-API section, model unload/delete,
// pull/download UI, and panel open/close wiring.
//
// Depends on: config.js      (OLLAMA_BASE, IMG_API_BASE,
//                              IMG_API_FLAVOR)
//             api.js         (API.*, OllamaAPI, LMStudioAPI,
//                             OpenAIAPI — lazily at call-time)
//             main.js        (checkOllama, modelCaps, API_FLAVOR,
//                             statusDot)
//
// Load order in index.html:  … → backend.js → status-panel.js

// ══ STATUS / MODEL MANAGEMENT PANEL ═════════════════════════
const statusPanelModal = document.getElementById('status-panel-modal');
const statusPanelBtn   = document.getElementById('status-panel-btn');
const spCloseBtn       = document.getElementById('sp-close-btn');
const spRefreshBtn     = document.getElementById('sp-refresh-btn');
const spSpinner        = document.getElementById('sp-spinner');
const spUnloadAllBtn   = document.getElementById('sp-unload-all-btn');

let spRefreshTimer = null;

function spFmtBytes(bytes) {
  if (!bytes || bytes === 0) return '—';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

function spFmtExpiry(iso) {
  if (!iso) return '';
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return 'expiring…';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `expires in ${h}h ${m % 60}m`;
  if (m > 0) return `expires in ${m}m ${s % 60}s`;
  return `expires in ${s}s`;
}

function spIsUrgent(iso) {
  if (!iso) return false;
  return (new Date(iso) - Date.now()) < 90_000;
}

function spUpdateBtnDot(state) {
  const dot = statusPanelBtn?.querySelector('.sp-btn-dot');
  if (!dot) return;
  dot.className = 'sp-btn-dot' + (state ? ' ' + state : '');
}

async function spRefresh() {
  if (!statusPanelModal || statusPanelModal.classList.contains('hidden')) return;
  spSpinner.classList.add('visible');
  try {
    const [models, running, ver] = await Promise.all([
      API.listModels().catch(() => null),
      API.runningModels().catch(() => []),
      API.serverVersion().catch(() => ({})),
    ]);
    const online = models !== null;
    spUpdateBtnDot(online ? 'online' : 'error');
    spRenderServer(online, ver);
    spRenderRunning(running || []);
    spRenderAvailable(online ? models : []);
  } catch {
    spUpdateBtnDot('error');
    spRenderServer(false, {});
    spRenderRunning([]);
    spRenderAvailable([]);
  }
  await spRefreshImageApi().catch(() => {});
  spSpinner.classList.remove('visible');
}

// ── Image API section in status panel ────────────────────────
async function spRefreshImageApi() {
  const sectionEl    = document.getElementById('sp-img-api-section');
  const runningSecEl = document.getElementById('sp-img-running-section');
  const modelSecEl   = document.getElementById('sp-img-models-section');
  const serverEl     = document.getElementById('sp-img-server-info');
  const listEl       = document.getElementById('sp-img-avail-list');
  const countEl      = document.getElementById('sp-img-avail-count');
  const runListEl    = document.getElementById('sp-img-running-list');
  const runCountEl   = document.getElementById('sp-img-running-count');
  const unloadAllBtn = document.getElementById('sp-img-unload-all-btn');
  if (!sectionEl || !listEl) return;

  if (!IMG_API_BASE) {
    sectionEl.classList.add('hidden');
    if (runningSecEl) runningSecEl.classList.add('hidden');
    if (modelSecEl)   modelSecEl.classList.add('hidden');
    return;
  }
  sectionEl.classList.remove('hidden');

  const imgBase   = IMG_API_BASE.replace(/\/$/, '');
  const flavorLbl = IMG_API_FLAVOR === 'ollama' ? 'Ollama' : 'OpenAI-compatible';

  try {
    // Fetch running models (Ollama only) and available image-capable models in parallel
    const [imgRunning, imgModels] = await Promise.all([
      IMG_API_FLAVOR === 'ollama'
        ? fetch(`${imgBase}/api/ps`, { signal: AbortSignal.timeout(5000) })
            .then(r => r.ok ? r.json() : {})
            .then(d => d.models || [])
            .catch(() => [])
        : Promise.resolve([]),
      IMG_API_FLAVOR === 'ollama'
        ? OllamaAPI.listImgModels(imgBase)
        : OpenAIAPI.fetchModelsList(imgBase)
    ]);

    if (serverEl) serverEl.innerHTML = `
      <div class="sp-server-row">
        <span class="status-dot online"></span>
        <span style="color:var(--text);font-size:12px">Connected</span>
        <span class="sp-server-version">${flavorLbl}</span>
        <span class="sp-server-url">${imgBase}</span>
      </div>`;

    // Running models — Ollama only
    if (runningSecEl) {
      if (IMG_API_FLAVOR === 'ollama') {
        runningSecEl.classList.remove('hidden');
        spRenderImgRunning(imgRunning, imgBase, runListEl, runCountEl, unloadAllBtn);
      } else {
        runningSecEl.classList.add('hidden');
      }
    }

    // Available image-capable models
    if (modelSecEl) modelSecEl.classList.remove('hidden');
    if (countEl) countEl.textContent = imgModels.length;
    imgModels.sort((a, b) => a.name.localeCompare(b.name));
    listEl.innerHTML = '';
    if (imgModels.length) {
      imgModels.forEach(m => {
        const card = document.createElement('div');
        card.className = 'sp-model-card';
        const d    = m.details || {};
        const meta = [d.family, d.parameter_size, d.quantization_level].filter(Boolean);
        card.innerHTML = `
          <div class="sp-model-card-top">
            <span class="sp-model-name">${m.name.replace(/:latest$/, '')}</span>
            ${m.size ? `<span class="sp-size-badge">${spFmtBytes(m.size)}</span>` : ''}
          </div>
          ${meta.length ? `<div class="sp-model-meta">${meta.join(' · ')}</div>` : ''}`;
        listEl.appendChild(card);
      });
    } else {
      listEl.innerHTML = '<div class="sp-empty">No image-capable models found on image API server</div>';
    }
  } catch (e) {
    if (serverEl) serverEl.innerHTML = `
      <div class="sp-server-row">
        <span class="status-dot error"></span>
        <span style="color:var(--text);font-size:12px">Unreachable</span>
        <span class="sp-server-version">${flavorLbl}</span>
        <span class="sp-server-url">${imgBase}</span>
      </div>`;
    if (runningSecEl) runningSecEl.classList.add('hidden');
    if (modelSecEl)   modelSecEl.classList.remove('hidden');
    if (countEl) countEl.textContent = '0';
    listEl.innerHTML = `<div class="sp-empty">Image API unreachable: ${e.message}</div>`;
  }
}

// ── Image API running-model renderer ─────────────────────────
function spRenderImgRunning(models, imgBase, listEl, countEl, unloadAllBtn) {
  if (!listEl) return;
  if (countEl) countEl.textContent = models.length;
  if (unloadAllBtn) unloadAllBtn.classList.toggle('hidden', models.length < 2);

  if (!models.length) {
    listEl.innerHTML = '<div class="sp-empty">No models currently loaded in memory</div>';
    return;
  }

  listEl.innerHTML = '';
  models.forEach(m => {
    const card   = document.createElement('div');
    card.className = 'sp-model-card';
    const total  = m.size      || 0;
    const vram   = m.size_vram || 0;
    const isCPU  = vram === 0;
    const pct    = total > 0 ? Math.round((vram / total) * 100) : 0;
    const expiry = spFmtExpiry(m.expires_at);
    const urgent = spIsUrgent(m.expires_at);

    card.innerHTML = `
      <div class="sp-model-card-top">
        <span class="sp-model-name">${m.name}</span>
        <span class="sp-size-badge">${isCPU ? 'CPU' : 'VRAM'} · ${spFmtBytes(isCPU ? total : vram)}</span>
        <button class="icon-btn" data-img-model="${m.name}" style="font-size:10px;color:var(--red);flex-shrink:0">unload</button>
      </div>
      ${total > 0 ? `
        <div class="sp-mem-row">
          <span>${isCPU ? 'RAM' : 'VRAM'}: ${spFmtBytes(isCPU ? total : vram)}${!isCPU ? ` of ${spFmtBytes(total)} (${pct}%)` : ''}</span>
          ${!isCPU ? `<div class="sp-vram-bar-track"><div class="sp-vram-bar-fill" style="width:${pct}%"></div></div>` : ''}
        </div>` : ''}
      ${expiry ? `<div class="sp-expiry${urgent ? ' sp-urgent' : ''}">${expiry}</div>` : ''}`;

    card.querySelector('[data-img-model]')?.addEventListener('click', e => {
      spImgUnloadOne(e.currentTarget.dataset.imgModel, imgBase);
    });
    listEl.appendChild(card);
  });
}

// ── Image API unload helpers ──────────────────────────────────
async function spImgUnloadOne(modelName, imgBase) {
  try {
    await fetch(`${imgBase}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: modelName, keep_alive: 0 })
    });
  } catch (e) { console.warn('Image API unload failed', e); }
  spRefresh();
}

async function spImgUnloadAll() {
  const imgBase = (IMG_API_BASE || '').replace(/\/$/, '');
  const btns = document.querySelectorAll('#sp-img-running-list [data-img-model]');
  for (const btn of btns) {
    try {
      await fetch(`${imgBase}/api/generate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model: btn.dataset.imgModel, keep_alive: 0 })
      });
    } catch {}
  }
  spRefresh();
}

function spRenderServer(online, ver) {
  const el = document.getElementById('sp-server-info');
  if (!el) return;
  const _srvLabels = { ollama: 'Ollama', lmstudio: 'LM Studio', openai: 'OpenAI-compatible API' };
  const vStr = ver.version ? `Ollama v${ver.version}` : (_srvLabels[API_FLAVOR] || 'API');
  el.innerHTML = `
    <div class="sp-server-row">
      <span class="status-dot ${online ? 'online' : 'error'}"></span>
      <span style="color:var(--text);font-size:12px">${online ? 'Connected' : 'Offline'}</span>
      <span class="sp-server-version">${vStr}</span>
      <span class="sp-server-url">${OLLAMA_BASE}</span>
    </div>`;
}

function spRenderRunning(models) {
  const list    = document.getElementById('sp-running-list');
  const countEl = document.getElementById('sp-running-count');
  if (!list) return;

  countEl.textContent = models.length;
  spUnloadAllBtn.classList.toggle('hidden', models.length < 2);

  if (!models.length) {
    list.innerHTML = '<div class="sp-empty">No models currently loaded in memory</div>';
    return;
  }

  list.innerHTML = '';
  models.forEach(m => {
    const card   = document.createElement('div');
    card.className = 'sp-model-card';
    const total  = m.size      || 0;
    const vram   = m.size_vram || 0;
    const isCPU  = vram === 0;
    const pct    = total > 0 ? Math.round((vram / total) * 100) : 0;
    const expiry = spFmtExpiry(m.expires_at);
    const urgent = spIsUrgent(m.expires_at);

    card.innerHTML = `
      <div class="sp-model-card-top">
        <span class="sp-model-name">${m.name}</span>
        <span class="sp-size-badge">${isCPU ? 'CPU' : 'VRAM'} · ${spFmtBytes(isCPU ? total : vram)}</span>
        ${(API.isOllama() || API.isLMStudio()) ? `<button class="icon-btn" data-model="${m.name}" style="font-size:10px;color:var(--red);flex-shrink:0">unload</button>` : ''}
      </div>
      ${total > 0 ? `
        <div class="sp-mem-row">
          <span>${isCPU ? 'RAM' : 'VRAM'}: ${spFmtBytes(isCPU ? total : vram)}${!isCPU ? ` of ${spFmtBytes(total)} (${pct}%)` : ''}</span>
          ${!isCPU ? `<div class="sp-vram-bar-track"><div class="sp-vram-bar-fill" style="width:${pct}%"></div></div>` : ''}
        </div>` : ''}
      ${expiry ? `<div class="sp-expiry${urgent ? ' sp-urgent' : ''}">${expiry}</div>` : ''}`;

    card.querySelector('[data-model]')?.addEventListener('click', e => { spUnloadOne(e.currentTarget.dataset.model); });
    list.appendChild(card);
  });
}

function spRenderAvailable(models) {
  const list    = document.getElementById('sp-avail-list');
  const countEl = document.getElementById('sp-avail-count');
  if (!list) return;

  countEl.textContent = models.length;
  if (!models.length) { list.innerHTML = '<div class="sp-empty">No models found</div>'; return; }

  models.sort((a, b) => {
    const ac = modelCaps.get(a.name) || new Set();
    const bc = modelCaps.get(b.name) || new Set();
    const ai = ac.has('image') ? 1 : 0;
    const bi = bc.has('image') ? 1 : 0;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });

  const CAP_MAP = {
    completion: { label: 'text',     cls: 'completion' },
    vision:     { label: 'vision',   cls: 'vision'     },
    thinking:   { label: 'thinking', cls: 'thinking'   },
    image:      { label: 'image gen',cls: 'image-gen'  },
    tools:      { label: 'tools',    cls: 'tools'      },
    audio:      { label: 'audio',    cls: 'audio'      },
    embedding:  { label: 'embed',    cls: 'embedding'  },
  };

  list.innerHTML = '';
  models.forEach(m => {
    const card = document.createElement('div');
    card.className = 'sp-model-card';
    const d    = m.details || {};
    const meta = [d.family, d.parameter_size, d.quantization_level].filter(Boolean);
    const date = m.modified_at
      ? new Date(m.modified_at).toLocaleDateString(undefined, { year:'2-digit', month:'short', day:'numeric' })
      : '';
    const caps   = modelCaps.get(m.name) || new Set();
    const badges = [...caps]
      .filter(c => CAP_MAP[c])
      .map(c => `<span class="sp-cap ${CAP_MAP[c].cls}">${CAP_MAP[c].label}</span>`)
      .join('');

    card.innerHTML = `
      <div class="sp-model-card-top">
        <span class="sp-model-name">${m.name.replace(/:latest$/, '')}</span>
        <span class="sp-size-badge">${spFmtBytes(m.size)}</span>
        ${API.isOllama() ? `<button class="icon-btn sp-delete-btn" data-delete="${m.name}" title="Delete model">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>` : API.isLMStudio() ? `<button class="icon-btn sp-delete-btn" disabled title="LM Studio does not expose a model-deletion endpoint" style="opacity:0.3;cursor:not-allowed">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>` : ''}
      </div>
      ${meta.length || date ? `
        <div class="sp-model-meta">
          ${meta.map((t, i) => i < meta.length - 1
            ? `<span>${t}</span><span class="sp-meta-sep">·</span>`
            : `<span>${t}</span>`).join('')}
          ${meta.length && date ? '<span class="sp-meta-sep">·</span>' : ''}
          ${date ? `<span>${date}</span>` : ''}
        </div>` : ''}
      ${badges ? `<div class="sp-caps">${badges}</div>` : ''}`;

    card.querySelector('[data-delete]')?.addEventListener('click', e => { spDeleteModel(e.currentTarget.dataset.delete); });
    list.appendChild(card);
  });
}

async function spUnloadOne(modelName) {
  try { await API.unloadModel(modelName); } catch (e) { console.warn('Unload failed', e); }
  spRefresh();
}

async function spUnloadAll() {
  const btns = document.querySelectorAll('#sp-running-list [data-model]');
  for (const btn of btns) { try { await API.unloadModel(btn.dataset.model); } catch {} }
  spRefresh();
}

async function spDeleteModel(modelName) {
  if (!API.isOllama()) { alert('Model deletion is not supported by this API.'); return; }
  if (!confirm(`Delete "${modelName}" from Ollama?\nThis cannot be undone.`)) return;
  try { await API.deleteModel(modelName); } catch (e) { console.warn('Delete failed', e); }
  await checkOllama();
  await spRefresh();
}

// ── Pull / download model ─────────────────────────────────────
// Dispatches to the active flavour's spPullModel implementation.
let spPullAbort = null;

const spPullInput     = document.getElementById('sp-pull-input');
const spPullBtn       = document.getElementById('sp-pull-btn');
const spPullCancelBtn = document.getElementById('sp-pull-cancel-btn');
const spPullProgress  = document.getElementById('sp-pull-progress');
const spPullStatusEl  = document.getElementById('sp-pull-status');
const spPullPctEl     = document.getElementById('sp-pull-pct');
const spPullBarFill   = document.getElementById('sp-pull-bar-fill');
const spPullDetail    = document.getElementById('sp-pull-detail');

function spFmtBytesDown(completed, total) {
  const fmt = b => b >= 1e9 ? (b/1e9).toFixed(2)+' GB'
                 : b >= 1e6 ? (b/1e6).toFixed(1)+' MB'
                 : b >= 1e3 ? (b/1e3).toFixed(0)+' KB'
                 : b+' B';
  if (!total) return fmt(completed);
  return `${fmt(completed)} / ${fmt(total)}`;
}

function spSetPullState(busy) {
  spPullBtn.classList.toggle('hidden', busy);
  spPullCancelBtn.classList.toggle('hidden', !busy);
  spPullInput.disabled = busy;
}

function spPullSetStatus(msg, cls = '') {
  if (!spPullStatusEl) return;
  spPullStatusEl.textContent = msg;
  spPullStatusEl.className = 'sp-pull-status-text' + (cls ? ' ' + cls : '');
}

async function spPullModel() {
  const name = spPullInput?.value.trim();
  if (!name) { spPullInput?.focus(); return; }

  if (API.isOpenAI()) {
    spPullSetStatus('Model download is not supported by OpenAI-compatible APIs.', 'sp-error');
    spPullProgress.classList.remove('hidden');
    return;
  }

  if (API.isLMStudio()) {
    await LMStudioAPI.spPullModel(name);
    return;
  }

  // Ollama streaming pull
  await OllamaAPI.spPullModel(name);
}

spPullBtn?.addEventListener('click', spPullModel);
spPullInput?.addEventListener('keydown', e => { if (e.key === 'Enter') spPullModel(); });
spPullCancelBtn?.addEventListener('click', () => spPullAbort?.abort());

// ── Wire up status panel ──────────────────────────────────────
statusPanelBtn?.addEventListener('click', () => {
  statusPanelModal.classList.remove('hidden');
  spRefresh();
  spRefreshTimer = setInterval(spRefresh, 5000);
});

function spClose() {
  statusPanelModal.classList.add('hidden');
  clearInterval(spRefreshTimer);
  spRefreshTimer = null;
}

spCloseBtn?.addEventListener('click', spClose);
spRefreshBtn?.addEventListener('click', spRefresh);
spUnloadAllBtn?.addEventListener('click', spUnloadAll);
document.getElementById('sp-img-unload-all-btn')?.addEventListener('click', spImgUnloadAll);
statusPanelModal?.addEventListener('click', e => { if (e.target === statusPanelModal) spClose(); });

// Keep the btn dot in sync with the main connection status check
const _statusDotObserver = new MutationObserver(() => {
  if (statusDot.classList.contains('online'))      spUpdateBtnDot('online');
  else if (statusDot.classList.contains('error'))  spUpdateBtnDot('error');
  else                                              spUpdateBtnDot('');
});
_statusDotObserver.observe(statusDot, { attributes: true, attributeFilter: ['class'] });
