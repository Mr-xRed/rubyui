// ══ IMAGE.JS ═════════════════════════════════════════════════
// Image generation feature: progress bar, size/ratio picker,
// PNG metadata embedding, IndexedDB gallery, lightbox viewer,
// gallery ZIP export/import, and client-side image generation.
//
// Depends on: config.js  (IMG_API_MODE, IMG_API_BASE, OLLAMA_BASE,
//                         SHOW_STATS)
//             api.js     (API.isOllama etc. — unused directly;
//                         OllamaAPI.generateNative used below)
//             main.js    (currentAbortController, BACKEND_AVAILABLE,
//                         listImgModels — imgModelSel referenced here)
//
// Note: generateImageBackend() lives in backend.js (loaded after
// this file) and is called from generateImage() at runtime — safe
// because function bodies resolve globals lazily.
//
// Load order in index.html:  … → chat.js → image.js → backend.js → …

// ══ IMAGE GENERATION ═════════════════════════════════════════
let imgBusy = false;

const imgPrompt          = document.getElementById('img-prompt');
const imgModelSel        = document.getElementById('img-model-select');
const imgGenerateBtn     = document.getElementById('img-generate-btn');
const imgStopBtn         = document.getElementById('img-stop-btn');
const imgClearBtn        = document.getElementById('img-clear-btn');
const imgCopyPromptBtn   = document.getElementById('img-copy-prompt-btn');
const imgPastePromptBtn  = document.getElementById('img-paste-prompt-btn');
const imgClearGalleryBtn = document.getElementById('img-clear-gallery-btn');
const imgSpinner         = document.getElementById('img-spinner');
const imgError           = document.getElementById('img-error');
const imgStatus          = document.getElementById('img-status');
const imgGallery         = document.getElementById('img-gallery');
const imgGalleryEmpty    = document.getElementById('img-gallery-empty');

// ── Progress bar ──────────────────────────────────────────────
const imgProgressWrap  = document.getElementById('img-progress-wrap');
const imgProgressFill  = document.getElementById('img-progress-fill');
const imgProgressLabel = document.getElementById('img-progress-label');
const imgProgressSteps = document.getElementById('img-progress-steps');
let imgProgressInterval = null;
let imgProgressStart    = 0;
let imgProgressDuration = 60;
let imgGenStartTime     = 0;

// Native-mode hybrid progress state
let _nativeCalibrated     = 60;
let _nativeCorrectedTotal = 60;
const _POST_BUFFER_FRACTION = 0.12;

function _tickNativeSmooth() {
  const elapsed   = (Date.now() - imgGenStartTime) / 1000;
  const pct       = Math.min(98, (elapsed / _nativeCorrectedTotal) * 100);
  const remaining = Math.max(0, Math.round(_nativeCorrectedTotal - elapsed));
  imgProgressFill.style.width = pct + '%';
  if (remaining > 90)     imgProgressLabel.textContent = `~${Math.floor(remaining / 60)}m ${remaining % 60}s remaining`;
  else if (remaining > 1) imgProgressLabel.textContent = `~${remaining}s remaining`;
  else                    imgProgressLabel.textContent = 'almost there…';
}

// Measured generation times (seconds) per model at reference pixel counts.
const IMG_TIME_DATA = {
  'x/z-image-turbo': [
    { px: 256 * 256,   s: 20  },
    { px: 512 * 512,   s: 38  },
    { px: 768 * 768,   s: 82  },
    { px: 1024 * 1024, s: 135 },
    { px: 2048 * 2048, s: 465 },
  ],
  'x/flux2-klein': [
    { px: 256 * 256,   s: 9   },
    { px: 512 * 512,   s: 17  },
    { px: 768 * 768,   s: 34  },
    { px: 1024 * 1024, s: 60  },
    { px: 2048 * 2048, s: 240 },
  ],
};

const IMG_DEFAULT_STEPS = {
  'x/flux2-klein':   4,
  'x/z-image-turbo': 9,
};

const IMG_LARGE_SCALE_EXPONENT = 1.10;

function estimateGenerationTime(model, size, steps) {
  const parts = size.split('x').map(Number);
  const area  = (parts[0] || 1024) * (parts[1] || 1024);
  const modelKey = model.replace(/:[\w.-]+$/, '');
  const data  = IMG_TIME_DATA[modelKey];
  if (!data) return 60;

  const pts = [...data].sort((a, b) => a.px - b.px);
  let base;
  if (area <= pts[0].px) {
    base = pts[0].s * (area / pts[0].px);
  } else if (area >= pts[pts.length - 1].px) {
    const last = pts[pts.length - 1];
    base = last.s * Math.pow(area / last.px, IMG_LARGE_SCALE_EXPONENT);
  } else {
    base = 60;
    for (let i = 0; i < pts.length - 1; i++) {
      if (area >= pts[i].px && area <= pts[i + 1].px) {
        const t = (area - pts[i].px) / (pts[i + 1].px - pts[i].px);
        base = pts[i].s + t * (pts[i + 1].s - pts[i].s);
        break;
      }
    }
  }
  const defaultSteps   = IMG_DEFAULT_STEPS[modelKey] || 1;
  const effectiveSteps = (steps && steps > 0) ? steps : defaultSteps;
  return base * (effectiveSteps / defaultSteps);
}

function _tickProgressBar() {
  const elapsed = (Date.now() - imgProgressStart) / 1000;
  const maxPct  = 90;
  const pct     = Math.min(maxPct, (elapsed / imgProgressDuration) * maxPct);
  imgProgressFill.style.width = pct + '%';
  const remaining = Math.max(0, Math.round(imgProgressDuration - elapsed));
  if (remaining > 90)      imgProgressLabel.textContent = `~${Math.floor(remaining / 60)}m ${remaining % 60}s remaining`;
  else if (remaining > 5)  imgProgressLabel.textContent = `~${remaining}s remaining`;
  else if (pct >= maxPct)  imgProgressLabel.textContent = 'almost there…';
  else                     imgProgressLabel.textContent = `~${remaining}s remaining`;
}

function startProgressBar(model, size, steps) {
  imgProgressFill.style.transition = 'none';
  imgProgressFill.style.width      = '0%';
  imgProgressWrap.classList.remove('hidden');

  if (IMG_API_MODE === 'native') {
    _nativeCalibrated     = Math.max(5, estimateGenerationTime(model, size, steps));
    _nativeCorrectedTotal = _nativeCalibrated;
    if (imgProgressSteps) imgProgressSteps.textContent = 'Step 0 / …';
    _tickNativeSmooth();
    imgProgressInterval = setInterval(_tickNativeSmooth, 1000);
    return;
  }

  imgProgressDuration = Math.max(5, estimateGenerationTime(model, size, steps));
  imgProgressStart    = Date.now();
  imgProgressLabel.textContent = '';
  _tickProgressBar();
  imgProgressInterval = setInterval(_tickProgressBar, 500);
}

function updateNativeProgress(completed, total) {
  if (!total || total <= 0) return;
  const elapsed    = (Date.now() - imgGenStartTime) / 1000;
  const stepRate   = elapsed / completed;
  const diffusion  = stepRate * total;
  const postBuffer = _nativeCalibrated * _POST_BUFFER_FRACTION;
  const liveTotal  = diffusion + postBuffer;
  const weight     = Math.min(0.65, completed / total);
  _nativeCorrectedTotal = _nativeCalibrated * (1 - weight) + liveTotal * weight;
  if (imgProgressSteps) imgProgressSteps.textContent = `Step ${completed} / ${total}`;
}

function stopProgressBar(success, genTimeStr) {
  clearInterval(imgProgressInterval);
  imgProgressInterval = null;
  if (imgProgressSteps) imgProgressSteps.textContent = '';
  if (success) {
    imgProgressFill.style.transition = 'width 0.25s ease';
    imgProgressFill.style.width      = '100%';
    imgProgressLabel.textContent     = genTimeStr ? `done in ${genTimeStr}` : 'done';
    setTimeout(() => {
      imgProgressWrap.classList.add('hidden');
      imgProgressFill.style.transition = 'none';
      imgProgressFill.style.width      = '0%';
    }, 2500);
  } else {
    imgProgressWrap.classList.add('hidden');
    imgProgressFill.style.transition = 'none';
    imgProgressFill.style.width      = '0%';
  }
}

// ── Persist model preference ──────────────────────────────────
const IMG_LAST_MODEL = localStorage.getItem('img_last_model') || 'x/flux2-klein';
if (imgModelSel) imgModelSel.value = IMG_LAST_MODEL;
imgModelSel?.addEventListener('change', () => localStorage.setItem('img_last_model', imgModelSel.value));

// ── Size / aspect ratio picker ────────────────────────────────
const IMG_RATIOS = {
  square:    { label: '1024 × 1024', resolutions: ['256x256', '512x512', '1024x1024', '2048x2048'] },
  landscape: { label: '1024 × 768',  resolutions: ['640x480', '800x608', '1024x768', '1280x960'] },
  portrait:  { label: '768 × 1024',  resolutions: ['480x640', '608x800', '768x1024', '960x1280'] },
  wide:      { label: '1280 × 720',  resolutions: ['848x480', '1280x720', '1920x1080'] },
  tall:      { label: '720 × 1280',  resolutions: ['480x848', '720x1280', '1080x1920'] },
  ultra:     { label: '1504 × 640',  resolutions: ['1008x432', '1504x640', '2512x1072'] },
  hd:        { label: '1920 × 1080', resolutions: ['1280x720', '1920x1080', '2688x1504'] },
};

let imgSelectedRatio = localStorage.getItem('img_last_ratio') || 'square';
let imgSelectedRes   = localStorage.getItem('img_last_res')   || '';

const imgRatioBtns    = document.getElementById('img-ratio-btns');
const imgResRow       = document.getElementById('img-res-row');
const imgResBtns      = document.getElementById('img-res-btns');
const imgCustomInputs = document.getElementById('img-custom-inputs');
const imgCustomWEl    = document.getElementById('img-custom-w');
const imgCustomHEl    = document.getElementById('img-custom-h');
const imgSizeReadout  = document.getElementById('img-size-readout');

function formatRes(res) { return res.replace('x', ' × '); }
function updateReadout(text) { if (imgSizeReadout) imgSizeReadout.textContent = text; }

function buildResButtons(ratio) {
  if (!imgResBtns) return;
  imgResBtns.innerHTML = '';
  const resolutions = IMG_RATIOS[ratio]?.resolutions || [];
  const defaultRes  = resolutions[Math.floor(resolutions.length / 2)];
  const active = resolutions.includes(imgSelectedRes) ? imgSelectedRes : defaultRes;
  imgSelectedRes = active;
  localStorage.setItem('img_last_res', active);
  updateReadout(formatRes(active));

  resolutions.forEach(res => {
    const btn = document.createElement('button');
    btn.className = 'img-res-btn' + (res === active ? ' active' : '');
    btn.textContent = formatRes(res);
    btn.addEventListener('click', () => {
      imgResBtns.querySelectorAll('.img-res-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      imgSelectedRes = res;
      localStorage.setItem('img_last_res', res);
      updateReadout(formatRes(res));
    });
    imgResBtns.appendChild(btn);
  });
}

function selectRatio(ratio) {
  imgSelectedRatio = ratio;
  localStorage.setItem('img_last_ratio', ratio);
  imgRatioBtns?.querySelectorAll('.img-ratio-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.ratio === ratio)
  );
  const isCustom = ratio === 'custom';
  imgCustomInputs?.classList.toggle('hidden', !isCustom);
  imgResRow?.classList.toggle('hidden', isCustom);
  if (!isCustom) {
    buildResButtons(ratio);
  } else {
    updateReadout(`${imgCustomWEl?.value || 1024} × ${imgCustomHEl?.value || 1024}`);
  }
}

function getImgSize() {
  if (imgSelectedRatio === 'custom') {
    const w = Math.max(64, Math.min(2048, parseInt(imgCustomWEl?.value) || 1024));
    const h = Math.max(64, Math.min(2048, parseInt(imgCustomHEl?.value) || 1024));
    return `${w}x${h}`;
  }
  return imgSelectedRes || '1024x1024';
}

imgRatioBtns?.querySelectorAll('.img-ratio-btn').forEach(btn => {
  btn.addEventListener('click', () => selectRatio(btn.dataset.ratio));
});

function onCustomSizeChange() {
  updateReadout(`${imgCustomWEl.value} × ${imgCustomHEl.value}`);
  localStorage.setItem('img_custom_w', imgCustomWEl.value);
  localStorage.setItem('img_custom_h', imgCustomHEl.value);
}
imgCustomWEl?.addEventListener('input', onCustomSizeChange);
imgCustomHEl?.addEventListener('input', onCustomSizeChange);

if (imgCustomWEl) imgCustomWEl.value = localStorage.getItem('img_custom_w') || 1024;
if (imgCustomHEl) imgCustomHEl.value = localStorage.getItem('img_custom_h') || 1024;

selectRatio(imgSelectedRatio);

// ── PNG metadata injection ─────────────────────────────────────
const _pngCrcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function _pngCrc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = _pngCrcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function _pngChunk(typeStr, data) {
  const enc  = new TextEncoder();
  const type = enc.encode(typeStr);
  const len  = data.length;
  const chunk = new Uint8Array(4 + 4 + len + 4);
  const view  = new DataView(chunk.buffer);
  view.setUint32(0, len, false);
  chunk.set(type, 4);
  chunk.set(data, 8);
  const crcBuf = new Uint8Array(4 + len);
  crcBuf.set(type);
  crcBuf.set(data, 4);
  view.setUint32(8 + len, _pngCrc32(crcBuf), false);
  return chunk;
}

function _makeTEXt(keyword, text) {
  const enc  = new TextEncoder();
  const kw   = enc.encode(keyword);
  const txt  = enc.encode(text);
  const data = new Uint8Array(kw.length + 1 + txt.length);
  data.set(kw); data[kw.length] = 0; data.set(txt, kw.length + 1);
  return _pngChunk('tEXt', data);
}

function _makeITXt(keyword, text) {
  const enc  = new TextEncoder();
  const kw   = enc.encode(keyword);
  const txt  = enc.encode(text);
  const data = new Uint8Array(kw.length + 1 + 1 + 1 + 1 + 1 + txt.length);
  let i = 0;
  data.set(kw, i); i += kw.length;
  data[i++] = 0; data[i++] = 0; data[i++] = 0; data[i++] = 0; data[i++] = 0;
  data.set(txt, i);
  return _pngChunk('iTXt', data);
}

function _buildXmpChunk(prompt, description, created) {
  if (!prompt) return null;
  const x = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const xml = [
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>`,
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">`,
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`,
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">`,
    `  <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${x(prompt)}</rdf:li></rdf:Alt></dc:title>`,
    description ? `  <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${x(description)}</rdf:li></rdf:Alt></dc:description>` : '',
    created     ? `  <xmp:CreateDate>${x(created)}</xmp:CreateDate>` : '',
    `  <xmp:CreatorTool>Jarvis / Ollama</xmp:CreatorTool>`,
    `</rdf:Description>`,
    `</rdf:RDF>`,
    `</x:xmpmeta>`,
    `<?xpacket end="w"?>`,
  ].filter(Boolean).join('\n');
  return _makeITXt('XML:com.adobe.xmp', xml);
}

function embedPngMeta(b64, prompt, description, created) {
  try {
    const chunk = _buildXmpChunk(prompt, description, created);
    if (!chunk) return b64;
    const bin = atob(b64);
    const src = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) src[i] = bin.charCodeAt(i);
    const INSERT = 33;
    const out = new Uint8Array(src.length + chunk.length);
    out.set(src.slice(0, INSERT));
    out.set(chunk, INSERT);
    out.set(src.slice(INSERT), INSERT + chunk.length);
    let str = '';
    const STEP = 8192;
    for (let i = 0; i < out.length; i += STEP) str += String.fromCharCode(...out.subarray(i, i + STEP));
    return btoa(str);
  } catch (e) {
    console.warn('embedPngMeta failed, returning original:', e);
    return b64;
  }
}

// ── Image database (IndexedDB) ────────────────────────────────
const _IDB_NAME    = 'jarvis_img_v2';
const _IDB_VERSION = 1;
const _IDB_STORE   = 'images';
let   _idb         = null;

function _openImgDb() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB_NAME, _IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(_IDB_STORE)) {
        const store = db.createObjectStore(_IDB_STORE, { keyPath: 'id' });
        store.createIndex('ts', 'ts', { unique: false });
      }
    };
    req.onsuccess = e => { _idb = e.target.result; resolve(_idb); };
    req.onerror   = () => reject(req.error);
  });
}

async function imgDbLoad() {
  const db = await _openImgDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(_IDB_STORE, 'readonly');
    const req = tx.objectStore(_IDB_STORE).index('ts').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

async function imgDbAdd(entry) {
  const db = await _openImgDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_IDB_STORE, 'readwrite');
    tx.objectStore(_IDB_STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function imgDbRemove(id) {
  const db = await _openImgDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_IDB_STORE, 'readwrite');
    tx.objectStore(_IDB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function imgDbClear() {
  const db = await _openImgDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_IDB_STORE, 'readwrite');
    tx.objectStore(_IDB_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// ── Gallery ZIP export ────────────────────────────────────────
async function exportGalleryDb() {
  const btn  = document.getElementById('img-export-db-btn');
  const orig = btn ? btn.innerHTML : '';

  if (typeof JSZip === 'undefined') {
    alert('Export failed: JSZip library not loaded. Check your internet connection and reload the page.');
    return;
  }

  let entries;
  try { entries = await imgDbLoad(); }
  catch (e) { alert('Export failed: could not read the gallery database.\n' + e.message); return; }

  if (!entries.length) { alert('The gallery is empty — nothing to export.'); return; }

  if (btn) { btn.textContent = 'packing…'; btn.style.color = 'var(--text-muted)'; }

  try {
    const zip = new JSZip();
    const imgFolder = zip.folder('images');
    const manifest  = [];

    for (const entry of entries) {
      const { id, b64, prompt, model, size, genTime, ts } = entry;
      const filename = imgFilename(model, ts);
      const binStr   = atob(b64);
      const bytes    = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      imgFolder.file(filename, bytes, { binary: true });
      manifest.push({ id, prompt, model, size, genTime, ts, filename });
    }

    zip.file('manifest.json', JSON.stringify({
      _type: 'jarvis_gallery_zip', _version: 1,
      _exported: new Date().toISOString(), _count: entries.length, entries: manifest,
    }, null, 2));

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jarvis-gallery-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);

    if (btn) {
      btn.textContent = `✓ ${entries.length} saved`;
      btn.style.color = 'var(--green)';
      setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 2500);
    }
  } catch (e) {
    if (btn) { btn.innerHTML = orig; btn.style.color = ''; }
    alert('Export failed: ' + e.message);
  }
}

// ── Gallery ZIP import ────────────────────────────────────────
async function importGalleryDb() {
  const input  = document.createElement('input');
  input.type   = 'file';
  input.accept = '.zip,application/zip,application/x-zip-compressed';

  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;

    const btn  = document.getElementById('img-import-db-btn');
    const orig = btn ? btn.innerHTML : '';

    if (typeof JSZip === 'undefined') {
      alert('Import failed: JSZip library not loaded. Check your internet connection and reload the page.');
      return;
    }

    if (btn) { btn.textContent = 'reading…'; btn.style.color = 'var(--text-muted)'; }

    try {
      const zip = await JSZip.loadAsync(file);
      const manifestFile = zip.file('manifest.json');
      if (!manifestFile) throw new Error('No manifest.json found — is this a Jarvis gallery ZIP?');

      const manifestText = await manifestFile.async('string');
      const manifest     = JSON.parse(manifestText);

      if (manifest._type !== 'jarvis_gallery_zip' || !Array.isArray(manifest.entries)) {
        throw new Error('manifest.json is not a valid Jarvis gallery export.');
      }

      let existing;
      try { existing = new Set((await imgDbLoad()).map(e => e.id)); }
      catch { existing = new Set(); }

      let added = 0, skipped = 0;
      const toRender = [];

      for (const meta of manifest.entries) {
        const { id, prompt, model, size, genTime, ts, filename } = meta;
        if (!id || !filename) { skipped++; continue; }
        if (existing.has(id)) { skipped++; continue; }

        const pngFile = zip.file(`images/${filename}`);
        if (!pngFile) { console.warn('[gallery import] missing file:', filename); skipped++; continue; }

        const bytes = await pngFile.async('uint8array');
        let b64 = '';
        const STEP = 8192;
        for (let i = 0; i < bytes.length; i += STEP)
          b64 += String.fromCharCode(...bytes.subarray(i, i + STEP));
        b64 = btoa(b64);

        const entry = { id, b64, prompt, model, size, genTime, ts };
        try { await imgDbAdd(entry); toRender.push(entry); added++; }
        catch (e) { console.warn('[gallery import] failed to save entry', id, e); skipped++; }
      }

      toRender.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      toRender.forEach(entry => addImageToGallery(entry, false));

      if (btn) {
        btn.textContent = added ? `✓ +${added} added` : '✓ up to date';
        btn.style.color = 'var(--green)';
        setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 2500);
      }

      if (!added) {
        alert(`Nothing new to import — all ${skipped} image${skipped !== 1 ? 's' : ''} already exist in the gallery.`);
      } else if (skipped) {
        console.info(`[gallery import] added ${added}, skipped ${skipped} duplicates.`);
      }
    } catch (e) {
      if (btn) { btn.innerHTML = orig; btn.style.color = ''; }
      alert('Import failed: ' + e.message);
    }
  };

  input.click();
}

// One-time migration from old localStorage key → IndexedDB
async function _migrateLocalStorageGallery() {
  const OLD_KEY = 'img_gallery_db';
  const raw = localStorage.getItem(OLD_KEY);
  if (!raw) return;
  try {
    const entries = JSON.parse(raw);
    if (Array.isArray(entries) && entries.length) {
      for (const entry of entries) await imgDbAdd(entry);
      console.log(`[gallery] Migrated ${entries.length} image(s) from localStorage → IndexedDB`);
    }
    localStorage.removeItem(OLD_KEY);
  } catch (e) { console.warn('[gallery] localStorage migration failed:', e); }
}

// ── Gallery sort ──────────────────────────────────────────────
let imgSortDesc = true;

function sortGallery() {
  const cards = [...imgGallery.querySelectorAll('.img-card')];
  if (cards.length < 2) return;
  cards.sort((a, b) => {
    const tsA = parseInt(a.dataset.imgTs) || 0;
    const tsB = parseInt(b.dataset.imgTs) || 0;
    return imgSortDesc ? tsB - tsA : tsA - tsB;
  });
  cards.forEach(c => imgGallery.appendChild(c));
}

function setImgStatus(msg, state = '') {
  if (!imgStatus) return;
  imgStatus.textContent = msg;
  imgStatus.className = 'img-status' + (state ? ' img-status-' + state : '');
}

// ── Lightbox core (shared by gallery and chat) ────────────────
//
// _openLightboxFromSources(sources, startIdx)
//   sources : Array of { src: string, label?: string }
//             src   — image URL or data-URI (resolved lazily)
//             label — optional caption shown in counter area
//   startIdx: index into sources to show first
//
// openLightbox(startCard)     — gallery mode (existing API, unchanged)
// openChatLightbox(imgs, idx) — chat mode (new global)
//
function _openLightboxFromSources(sources, startIdx) {
  if (!sources.length) return;
  let idx = Math.max(0, Math.min(startIdx, sources.length - 1));

  const overlay = document.createElement('div');
  overlay.className = 'img-lightbox';
  overlay.style.contain = 'layout style paint';

  const bigImg = document.createElement('img');
  bigImg.className = 'lb-image';
  bigImg.setAttribute('aria-label', 'Zoomed image');
  bigImg.draggable  = false;
  // Promote to compositor layer before any gesture fires.
  // will-change:transform tells the browser to upload this element as its own
  // GPU layer immediately — so the first pinch frame is pure compositing with
  // no mid-gesture layer promotion stutter.
  // translateZ(0) is the belt-and-suspenders fallback for older WebKit.
  // object-fit:contain + max sizing let CSS handle layout without JS sizing logic.
  bigImg.style.willChange  = 'transform';
  bigImg.style.transform   = 'translateZ(0)';
  bigImg.style.objectFit   = 'contain';
  // Use dvw/dvh (dynamic viewport units) so the margin accounts for any
  // browser chrome (address bar, home indicator) that appears/disappears.
  // 88dvw / 80dvh leaves ~6% horizontal and ~10% vertical breathing room,
  // ensuring tall portrait images (e.g. 944x2048) never overflow the screen
  // and wide landscape images always have side margins.
  // These are hard viewport-relative limits — independent of the container —
  // so they work regardless of what the .lb-image CSS class defines.
  bigImg.style.maxWidth    = '88dvw';
  bigImg.style.maxHeight   = '80dvh';
  bigImg.style.imageRendering = 'high-quality';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'lb-nav lb-prev';
  prevBtn.setAttribute('aria-label', 'Previous image');
  prevBtn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;

  const nextBtn = document.createElement('button');
  nextBtn.className = 'lb-nav lb-next';
  nextBtn.setAttribute('aria-label', 'Next image');
  nextBtn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'lb-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  const counter = document.createElement('div');
  counter.className = 'lb-counter';

  overlay.appendChild(prevBtn);
  overlay.appendChild(bigImg);
  overlay.appendChild(nextBtn);
  overlay.appendChild(closeBtn);
  overlay.appendChild(counter);

  let _showToken = 0;
  function showAt(i) {
    if (!sources.length) { close(); return; }
    idx = ((i % sources.length) + sources.length) % sources.length;
    const token = ++_showToken;
    const src   = sources[idx].src;

    bigImg.style.opacity   = '0';
    bigImg.style.transform = 'translate3d(0,-30px,0) scale(0.97)';

    // Clear previous image immediately so the old frame never flashes
    // while the new src is decoding.
    bigImg.src = '';

    bigImg.onload = () => {
      if (token !== _showToken) return;
      bigImg.style.opacity   = '1';
      bigImg.style.transform = 'translate3d(0,-30px,0) scale(1)';
    };
    bigImg.onerror = () => {
      if (token !== _showToken) return;
      bigImg.style.opacity   = '1';
      bigImg.style.transform = 'translate3d(0,-30px,0) scale(1)';
    };

    // Setting src last — after onload is wired — avoids a race on cached images
    // where onload fires synchronously before the handler is attached.
    bigImg.src = src;

    const single = sources.length <= 1;
    prevBtn.style.visibility = single ? 'hidden' : '';
    nextBtn.style.visibility = single ? 'hidden' : '';
    counter.style.display    = single ? 'none'   : '';
    const label = sources[idx].label;
    counter.innerHTML = label
      ? `<span class="lb-counter-label">${label}</span>`
      : `<span>${idx + 1} / ${sources.length}</span>`;
  }

  let _scale = 1, _pinchStartDist = 0, _pinchStartScale = 1;
  let _panX = 0, _panY = -30, _panStartX = 0, _panStartY = 0, _panTouchId = null;
  let _isPinching = false;
  let _rafId = null;

  function _applyTransform() {
    if (_rafId !== null) return;
    _rafId = requestAnimationFrame(() => {
      _rafId = null;
      bigImg.style.transform = `translate3d(${_panX}px,${_panY}px,0) scale(${_scale})`;
    });
  }

  function _resetZoom() {
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    _unbakeScale();   // clears timer + restores CSS constraints synchronously
    _scale = 1; _panX = 0; _panY = 0;
    bigImg.style.transition = 'transform 0.2s ease';
    bigImg.style.transform  = 'translate3d(0,-30px,0) scale(1)';
    setTimeout(() => { bigImg.style.transition = ''; }, 200);
  }

  function close() {
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    _unbakeScale();
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  closeBtn.addEventListener('click', e => { e.stopPropagation(); close(); });
  prevBtn.addEventListener('click',  e => { e.stopPropagation(); _resetZoom(); showAt(idx - 1); });
  nextBtn.addEventListener('click',  e => { e.stopPropagation(); _resetZoom(); showAt(idx + 1); });

  function onKey(e) {
    if (e.key === 'ArrowLeft')  { e.preventDefault(); _resetZoom(); showAt(idx - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); _resetZoom(); showAt(idx + 1); }
    else if (e.key === 'Escape')     { close(); }
  }
  document.addEventListener('keydown', onKey);

  let touchStartX = 0, touchStartY = 0;
  let _pinchMidX = 0, _pinchMidY = 0;   // viewport midpoint between the two fingers
  let _pinchPanStartX = 0, _pinchPanStartY = 0; // _panX/_panY at pinch start

  overlay.addEventListener('touchstart', e => {
    bigImg.style.transition = 'none';
    overlay.classList.add('lb-gesturing');
    if (e.touches.length === 2) {
      e.preventDefault();
      _isPinching = true; _panTouchId = null;
      const t0 = e.touches[0], t1 = e.touches[1];
      const dx = t0.clientX - t1.clientX;
      const dy = t0.clientY - t1.clientY;
      _pinchStartDist  = Math.hypot(dx, dy);
      _pinchStartScale = _scale;
      // Midpoint in viewport coords — this is the anchor point.
      _pinchMidX = (t0.clientX + t1.clientX) / 2;
      _pinchMidY = (t0.clientY + t1.clientY) / 2;
      // Remember pan offset at gesture start so we can solve for the
      // correct pan on every move tick.
      _pinchPanStartX = _panX;
      _pinchPanStartY = _panY;
    } else if (e.touches.length === 1) {
      touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY;
      _panTouchId = e.touches[0].identifier;
      _panStartX  = _panX; _panStartY = _panY;
    }
  }, { passive: false });

  overlay.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const t0 = e.touches[0], t1 = e.touches[1];
      const dx   = t0.clientX - t1.clientX;
      const dy   = t0.clientY - t1.clientY;
      const dist = Math.hypot(dx, dy);
      const newScale = Math.min(8, Math.max(1, _pinchStartScale * (dist / _pinchStartDist)));

      // Keep the pinch midpoint anchored, same math as the wheel handler:
      //   pan = pinchPanStart + pinchMid_imageSpace * (oldScale - newScale)
      // where pinchMid_imageSpace is the midpoint expressed in image-local
      // coordinates at the moment the gesture started.
      const rect  = bigImg.getBoundingClientRect();
      const imgCX = rect.left + rect.width  / 2;
      const imgCY = rect.top  + rect.height / 2;
      // Where the pinch midpoint sits in image-space (using start scale to
      // avoid drift as scale changes during the gesture).
      const midInImgX = (_pinchMidX - imgCX) / _scale;
      const midInImgY = (_pinchMidY - imgCY) / _scale;
      _panX = _pinchPanStartX + midInImgX * (_pinchStartScale - newScale);
      _panY = _pinchPanStartY + midInImgY * (_pinchStartScale - newScale);
      _scale = newScale;
      _applyTransform();
    } else if (e.touches.length === 1 && _scale > 1 && !_isPinching) {
      e.preventDefault();
      const t = [...e.touches].find(t => t.identifier === _panTouchId);
      if (t) {
        _panX = _panStartX + (t.clientX - touchStartX);
        _panY = _panStartY + (t.clientY - touchStartY);
        _applyTransform();
      }
    }
  }, { passive: false });

  overlay.addEventListener('touchend', e => {
    if (_isPinching && e.touches.length === 1) {
      touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY;
      _panTouchId = e.touches[0].identifier;
      _panStartX  = _panX; _panStartY = _panY;
    }
    if (e.touches.length < 2) _isPinching = false;
    if (e.touches.length === 0) overlay.classList.remove('lb-gesturing');
    if (!_isPinching && _scale < 1.05) _resetZoom();
    if (e.touches.length === 0 && _scale <= 1.05) {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        _resetZoom();
        if (dx < 0) showAt(idx + 1); else showAt(idx - 1);
      }
    }
  }, { passive: true });

  // ── Desktop: scroll-to-zoom ───────────────────────────────────
  // CSS transforms (scale) are compositor-only — the browser never
  // re-rasterizes for them, it just upscales the GPU texture → blurry.
  // Setting real CSS width/height DOES trigger re-rasterization (same
  // reason a window-resize fixes it instantly).
  //
  // Strategy:
  //   SCROLLING  → fast transform:scale() on compositor (60 fps, no layout).
  //   IDLE 800ms → "bake": set CSS width/height = baseW*scale, drop scale()
  //                from transform.  Browser re-rasterizes sharp.  No src swap.
  //   NEXT SCROLL→ "unbake": restore CSS constraints, switch back to scale().
  //
  // Key insight: _baseW/_baseH (the scale=1 rendered size) are computed
  // mathematically from naturalWidth/naturalHeight + viewport caps — never
  // from a DOM measurement after an unbake.  This keeps the numbers
  // consistent on the very same tick that unbaking happens, avoiding the
  // one-frame jump that triggered the off-centre / zoom-reset glitch.

  let _sharpenTimer = null;
  let _scaleBaked   = false;

  // Compute the CSS size the image occupies at scale=1, honouring the
  // 88dvw / 80dvh caps.  Pure arithmetic — no DOM read needed.
  function _computeBaseSize() {
    const nw = bigImg.naturalWidth  || 1;
    const nh = bigImg.naturalHeight || 1;
    const maxW = window.innerWidth  * 0.88;
    const maxH = window.innerHeight * 0.80;
    const ratio = Math.min(1, maxW / nw, maxH / nh);
    return { w: nw * ratio, h: nh * ratio };
  }

  // "Bake" _scale into real CSS dimensions so the browser re-rasterizes.
  function _bakeScale() {
    _sharpenTimer = null;
    if (_scale <= 1) return;
    const { w, h } = _computeBaseSize();
    bigImg.style.maxWidth  = 'none';
    bigImg.style.maxHeight = 'none';
    bigImg.style.width     = (w * _scale) + 'px';
    bigImg.style.height    = (h * _scale) + 'px';
    bigImg.style.transition = 'none';
    bigImg.style.transform  = `translate3d(${_panX}px,${_panY}px,0)`;
    _scaleBaked = true;
  }

  function _scheduleSharpen() {
    if (_sharpenTimer) clearTimeout(_sharpenTimer);
    _sharpenTimer = setTimeout(_bakeScale, 800);
  }

  // Restore transform-based zoom.  Fully synchronous — no rAF, no DOM read.
  // After this call _computeBaseSize() gives the correct base and the
  // wheel handler's getBoundingClientRect() will see the right constrained
  // size on the very same tick.
  function _unbakeScale() {
    if (_sharpenTimer) { clearTimeout(_sharpenTimer); _sharpenTimer = null; }
    if (!_scaleBaked) return;
    _scaleBaked = false;
    bigImg.style.width     = '';
    bigImg.style.height    = '';
    bigImg.style.maxWidth  = '88dvw';
    bigImg.style.maxHeight = '80dvh';
    // Re-apply the full transform immediately so there is no single frame
    // where the element is at constrained size without the scale factor.
    bigImg.style.transform = `translate3d(${_panX}px,${_panY}px,0) scale(${_scale})`;
  }

  function _applyTransformMaybeScaled() {
    if (_rafId !== null) return;
    _rafId = requestAnimationFrame(() => {
      _rafId = null;
      bigImg.style.transform = _scaleBaked
        ? `translate3d(${_panX}px,${_panY}px,0)`
        : `translate3d(${_panX}px,${_panY}px,0) scale(${_scale})`;
    });
  }

  overlay.addEventListener('wheel', e => {
    e.preventDefault();

    // Unbake synchronously BEFORE reading getBoundingClientRect so the
    // element is back to its constrained CSS size with scale() applied,
    // giving a consistent centre-point for the cursor-anchor math below.
    if (_scaleBaked) _unbakeScale();

    const ZOOM_SPEED = 0.0012;
    const factor    = 1 - e.deltaY * ZOOM_SPEED;
    const newScale  = Math.min(8, Math.max(1, _scale * factor));
    if (newScale === _scale) return;

    // Cursor-anchored zoom: keep the image pixel under the pointer fixed.
    const rect  = bigImg.getBoundingClientRect();
    const imgCX = rect.left + rect.width  / 2;
    const imgCY = rect.top  + rect.height / 2;
    const cursorInImgX = (e.clientX - imgCX) / _scale;
    const cursorInImgY = (e.clientY - imgCY) / _scale;
    _panX += cursorInImgX * (_scale - newScale);
    _panY += cursorInImgY * (_scale - newScale);
    _scale = newScale;

    bigImg.style.transition = 'none';
    _applyTransformMaybeScaled();
    if (_scale <= 1) { _resetZoom(); return; }
    _scheduleSharpen();
  }, { passive: false });

  // ── Desktop: mouse drag-to-pan ────────────────────────────────
  let _mouseDown = false, _mousePanStartX = 0, _mousePanStartY = 0;
  let _mousePanOriginX = 0, _mousePanOriginY = 0;

  overlay.addEventListener('mousedown', e => {
    // Only pan when zoomed in; left button only; don't steal nav/close clicks.
    if (e.button !== 0 || _scale <= 1) return;
    if (e.target === prevBtn || e.target === nextBtn || e.target === closeBtn ||
        prevBtn.contains(e.target) || nextBtn.contains(e.target) || closeBtn.contains(e.target)) return;
    e.preventDefault();
    _mouseDown = true;
    _mousePanStartX  = e.clientX;
    _mousePanStartY  = e.clientY;
    _mousePanOriginX = _panX;
    _mousePanOriginY = _panY;
    overlay.style.cursor = 'grabbing';
  });

  // Use window so the drag keeps working even if the pointer leaves the overlay.
  window.addEventListener('mousemove', e => {
    if (!_mouseDown) return;
    _panX = _mousePanOriginX + (e.clientX - _mousePanStartX);
    _panY = _mousePanOriginY + (e.clientY - _mousePanStartY);
    bigImg.style.transition = 'none';
    _applyTransformMaybeScaled();
  });

  window.addEventListener('mouseup', e => {
    if (!_mouseDown) return;
    _mouseDown = false;
    overlay.style.cursor = '';
  });

  // Show a grab cursor while hovering over a zoomed image.
  overlay.addEventListener('mousemove', e => {
    if (_mouseDown) return;
    overlay.style.cursor = _scale > 1 ? 'grab' : '';
  });

  // ── Desktop: double-click to reset zoom ───────────────────────
  bigImg.addEventListener('dblclick', e => {
    e.stopPropagation();
    _resetZoom();
  });

  // ── Mobile: double-tap to reset zoom ─────────────────────────
  let _lastTap = 0;
  bigImg.addEventListener('click', () => {
    const now = Date.now();
    if (now - _lastTap < 300) _resetZoom();
    _lastTap = now;
  });

  showAt(idx);
  document.body.appendChild(overlay);
}

// ── Gallery lightbox (existing public API — unchanged callers) ─
function openLightbox(startCard) {
  const cards = [...imgGallery.querySelectorAll('.img-card')];
  const startIdx = Math.max(0, cards.indexOf(startCard));
  const sources = cards.map(card => {
    const imgEl = card.querySelector('img');
    // Always use dataset.src (the raw base64 data-URI), never imgEl.src.
    // imgEl.src is the thumbnail decoded at card size; iOS Safari may cache
    // that decoded bitmap at reduced dimensions, so re-using it in the
    // lightbox causes intermittent low-res display depending on whether the
    // cache entry was populated before the tap.
    const src = imgEl.dataset.src || imgEl.src;
    return { src };
  });
  _openLightboxFromSources(sources, startIdx);
}

// ── Chat lightbox (new global called from chat.js) ─────────────
// imgs  : Array of { src: string, label?: string }
//         src   — data-URI or object URL of the image
//         label — optional filename / caption shown in the counter
// startIdx : which image to open first
function openChatLightbox(imgs, startIdx) {
  _openLightboxFromSources(imgs, startIdx || 0);
}

function imgFilename(model, ts) {
  const modelName = (model || 'unknown').split('/').pop();
  const d = new Date(Number(ts) || ts);
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `img_${modelName}_${stamp}.png`;
}

// ── Lazy-load observer ────────────────────────────────────────
const _galleryObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const img = entry.target;
    if (img.dataset.src) img.src = img.dataset.src;
    _galleryObserver.unobserve(img);
  });
}, { rootMargin: '300px' });

function addImageToGallery(entry, prepend = false) {
  const { id, b64, prompt, model, size, genTime, ts } = entry;
  imgGalleryEmpty.style.display = 'none';

  const card = document.createElement('div');
  card.className = 'img-card';
  card.dataset.imgId    = id;
  card.dataset.imgModel = model;
  card.dataset.imgTs    = ts;

  const img = document.createElement('img');
  img.dataset.src = `data:image/png;base64,${b64}`;
  img.alt = prompt;
  img.style.minHeight = '120px';
  img.addEventListener('click', () => openLightbox(card));
  _galleryObserver.observe(img);

  const date    = new Date(ts);
  const dateStr = date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const meta = document.createElement('div');
  meta.className = 'img-card-meta';
  meta.title = prompt;
  meta.innerHTML = `<span class="img-card-model">${model.split('/').pop().replace(/:latest$/i, '')} · ${size}${genTime ? ' · ' + genTime : ''}</span><span class="img-card-date">${dateStr}</span>`;

  const actions = document.createElement('div');
  actions.className = 'img-card-actions';

  const dlBtn = document.createElement('button');
  dlBtn.className = 'icon-btn';
  dlBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  dlBtn.title = 'Download image';
  dlBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = img.src || img.dataset.src;
    a.download = imgFilename(model, ts);
    a.click();
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'icon-btn';
  removeBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  removeBtn.title = 'Remove from gallery';
  removeBtn.addEventListener('click', async () => {
    card.remove();
    await imgDbRemove(id).catch(() => {});
    if (!imgGallery.querySelector('.img-card')) imgGalleryEmpty.style.display = '';
  });

  const copyPromptBtn = document.createElement('button');
  copyPromptBtn.className = 'icon-btn';
  copyPromptBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
  copyPromptBtn.onclick = async (e) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(prompt);
    const svg = copyPromptBtn.querySelector('svg');
    if (svg) svg.style.color = 'var(--accent)';
    setTimeout(() => { if (svg) svg.style.color = ''; }, 1500);
  };

  actions.appendChild(dlBtn);
  actions.appendChild(copyPromptBtn);
  actions.appendChild(removeBtn);
  card.appendChild(img);
  card.appendChild(meta);
  card.appendChild(actions);

  if (prepend && imgGallery.firstChild) {
    imgGallery.insertBefore(card, imgGallery.firstChild);
  } else {
    imgGallery.appendChild(card);
  }
}

// ── Restore persisted gallery on load ────────────────────────
(async function restoreGallery() {
  await _migrateLocalStorageGallery();
  const db = await imgDbLoad().catch(() => []);
  if (!db.length) return;
  const sorted = [...db].sort((a, b) => b.ts - a.ts);
  sorted.forEach(entry => addImageToGallery(entry, false));
})();
// ── Generate image (client-side) ──────────────────────────────
async function generateImage() {
  const prompt = imgPrompt.value.trim();
  if (!prompt || imgBusy) return;

  // Route to backend when available (server mode)
  if (BACKEND_AVAILABLE) { generateImageBackend(prompt); return; }

  imgBusy = true;
  imgGenerateBtn.classList.add('hidden');
  imgStopBtn.classList.remove('hidden');
  imgSpinner.classList.add('visible');
  imgError.style.display = 'none';
  setImgStatus('Generating…', 'busy');

  const model = imgModelSel.value;
  const size  = getImgSize();

  const seedEl   = document.getElementById('img-seed');
  const stepsEl  = document.getElementById('img-steps');
  const seedVal  = seedEl  ? parseInt(seedEl.value)  : NaN;
  const stepsVal = stepsEl ? parseInt(stepsEl.value) : NaN;
  const effectiveSteps = (!isNaN(stepsVal) && stepsVal > 0) ? stepsVal : 0;

  currentAbortController = new AbortController();
  imgGenStartTime = Date.now();
  let nativeGenTime = null;
  startProgressBar(model, size, IMG_API_MODE === 'native' ? effectiveSteps : 0);

  try {
    let b64Images = [];

    if (IMG_API_MODE === 'native') {
      // ── Native Ollama API (/api/generate) ─────────────────
      const sizeParts = size.split('x').map(Number);
      const body = { model, prompt, width: sizeParts[0] || 1024, height: sizeParts[1] || 1024 };
      if (effectiveSteps > 0)              body.steps = effectiveSteps;
      if (!isNaN(seedVal) && seedVal > 0)  body.options = { seed: seedVal };

      const result = await OllamaAPI.generateNative(body, currentAbortController.signal, updateNativeProgress);
      b64Images     = result.b64Images;
      nativeGenTime = result.nativeGenTime;

    } else {
      // ── OpenAI-compatible API (/v1/images/generations) ────
      // Sequential fallback, not raced (see ollama.js's generateNative for
      // why): direct first, and only if that fails — meaning it never
      // reached the model in the first place — retry once through our
      // own backend proxy.
      const genBase = (IMG_API_BASE || OLLAMA_BASE).replace(/\/$/, '');
      const genBody = JSON.stringify({ model, prompt, n: 1, size });
      let res;
      try {
        res = await fetch(`${genBase}/v1/images/generations`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          signal:  currentAbortController.signal,
          body:    genBody
        });
        if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
      } catch (directErr) {
        res = await fetch(`/api/ollama-proxy/v1/images/generations?base=${encodeURIComponent(genBase)}`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          signal:  currentAbortController.signal,
          body:    genBody
        });
        if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status} (via backend proxy)`);
      }
      const data   = await res.json();
      const images = data.data || [];
      if (!images.length) throw new Error('No image returned by the model.');
      images.forEach(item => { if (item.b64_json) b64Images.push(item.b64_json); });
    }

    // ── Common: embed metadata & add to gallery ────────────
    const wallTimeSec = ((Date.now() - imgGenStartTime) / 1000).toFixed(1);
    const genTimeStr  = (IMG_API_MODE === 'native' && nativeGenTime) ? nativeGenTime : wallTimeSec + 's';

    b64Images.forEach(rawB64 => {
      const creationTime = new Date().toISOString();
      const enrichedB64  = embedPngMeta(
        rawB64, prompt,
        `Model: ${model} | Size: ${size} | Gen: ${genTimeStr} | API: ${IMG_API_MODE} | Created: ${creationTime}`,
        creationTime
      );
      const entry = {
        id:      Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        b64:     enrichedB64,
        prompt, model, size,
        genTime: genTimeStr,
        ts:      Date.now()
      };
      imgDbAdd(entry);
      addImageToGallery(entry, imgSortDesc);
    });

    setImgStatus('Image generated', 'done');
    stopProgressBar(true, genTimeStr);
    setTimeout(() => setImgStatus(''), 3000);

  } catch (e) {
    if (e.name === 'AbortError') {
      stopProgressBar(false);
      setImgStatus('Cancelled', '');
      setTimeout(() => setImgStatus(''), 2000);
    } else {
      stopProgressBar(false);
      imgError.textContent = `Error: ${e.message}`;
      imgError.style.display = 'block';
      setImgStatus('');
    }
  } finally {
    imgBusy = false;
    imgGenerateBtn.classList.remove('hidden');
    imgStopBtn.classList.add('hidden');
    imgSpinner.classList.remove('visible');
    currentAbortController = null;
  }
}

// ── Tool-call image generation (decoupled from Image-mode UI) ─────
// Used by ToolsEngine's built-in `generate_image` tool (tools.js) so the
// model can generate images mid-chat without switching to Image mode.
// Deliberately does NOT touch Image-mode DOM (imgSpinner/imgError/
// imgGenerateBtn/etc.) or `currentAbortController` — that global is already
// in use by chat.js's in-flight streaming request when a tool call runs, so
// reusing it here would abort (or be aborted by) the chat request itself.
// Routes through the server job queue when available (same as
// generateImageBackend(), just awaited instead of fire-and-forget — see
// generateImageForToolBackend() in backend.js), otherwise falls back to the
// same direct native/OpenAI-compat calls generateImage() uses locally.
// Returns { b64, prompt, model, size, genTime } — never touches the
// gallery/IndexedDB itself; that's opt-in via the "Save to gallery" button
// on the rendered chat card (see chat.js's _toolImgSaveToGallery()).
async function generateImageForTool(prompt, width, height) {
  const model = imgModelSel ? imgModelSel.value : '';
  if (!model) throw new Error('No image model selected — check Settings → Image.');
  const size = `${width}x${height}`;
  const t0 = Date.now();
  let b64, genTimeStr;

  if (typeof BACKEND_AVAILABLE !== 'undefined' && BACKEND_AVAILABLE &&
      typeof generateImageForToolBackend === 'function') {
    // ── Server job-queue path ────────────────────────────────────
    const result = await generateImageForToolBackend(prompt, width, height, model, size);
    b64        = result.b64;
    genTimeStr = result.genTime || ((Date.now() - t0) / 1000).toFixed(1) + 's';

  } else if (IMG_API_MODE === 'native') {
    // ── Direct native Ollama API ─────────────────────────────────
    const ac   = new AbortController();
    const body = { model, prompt, width, height };
    const result = await OllamaAPI.generateNative(body, ac.signal, () => {});
    if (!result.b64Images?.length) throw new Error('No image returned by the model.');
    b64        = result.b64Images[0];
    genTimeStr = result.nativeGenTime || ((Date.now() - t0) / 1000).toFixed(1) + 's';

  } else {
    // ── Direct OpenAI-compatible API ─────────────────────────────
    const ac      = new AbortController();
    const genBase = (IMG_API_BASE || OLLAMA_BASE).replace(/\/$/, '');
    const genBody = JSON.stringify({ model, prompt, n: 1, size });
    let res;
    try {
      res = await fetch(`${genBase}/v1/images/generations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal, body: genBody
      });
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
    } catch (directErr) {
      res = await fetch(`/api/ollama-proxy/v1/images/generations?base=${encodeURIComponent(genBase)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal, body: genBody
      });
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status} (via backend proxy)`);
    }
    const data   = await res.json();
    const images = data.data || [];
    if (!images.length || !images[0].b64_json) throw new Error('No image returned by the model.');
    b64        = images[0].b64_json;
    genTimeStr = ((Date.now() - t0) / 1000).toFixed(1) + 's';
  }

  const creationTime = new Date().toISOString();
  const enrichedB64  = embedPngMeta(
    b64, prompt,
    `Model: ${model} | Size: ${size} | Gen: ${genTimeStr} | API: ${IMG_API_MODE} | Created: ${creationTime}`,
    creationTime
  );

  return { b64: enrichedB64, prompt, model, size, genTime: genTimeStr };
}

imgGenerateBtn?.addEventListener('click', generateImage);
imgStopBtn?.addEventListener('click', () => currentAbortController?.abort());
imgClearBtn?.addEventListener('click', () => { imgPrompt.value = ''; if (!isMobile()) imgPrompt.focus(); });
imgCopyPromptBtn?.addEventListener('click', async () => {
  const text = imgPrompt.value;
  if (!text) return;
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {} ta.remove();
  }
  imgCopyPromptBtn.textContent = 'copied!';
  setTimeout(() => imgCopyPromptBtn.textContent = 'copy', 1500);
});
imgPastePromptBtn?.addEventListener('click', async () => {
  try { const t = await navigator.clipboard.readText(); imgPrompt.value = t; if (!isMobile()) imgPrompt.focus(); }
  catch { alert('Clipboard access denied.'); }
});
document.getElementById('img-export-db-btn')?.addEventListener('click', exportGalleryDb);
document.getElementById('img-import-db-btn')?.addEventListener('click', importGalleryDb);
document.getElementById('img-sort-btn')?.addEventListener('click', () => {
  imgSortDesc = !imgSortDesc;
  sortGallery();
  const label = document.getElementById('img-sort-label');
  const btn   = document.getElementById('img-sort-btn');
  if (label) label.textContent = imgSortDesc ? '↓ New' : '↑ Old';
  if (btn)   btn.title = imgSortDesc ? 'Newest first' : 'Oldest first';
});
imgClearGalleryBtn?.addEventListener('click', async () => {
  imgGallery.querySelectorAll('.img-card').forEach(c => c.remove());
  await imgDbClear().catch(() => {});
  imgGalleryEmpty.style.display = '';
});
