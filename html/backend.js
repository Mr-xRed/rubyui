// ══ BACKEND.JS ═══════════════════════════════════════════════
// Python/nginx backend integration: health-check detection,
// completed-job sync into IndexedDB + gallery, SSE live-update
// listener, Server Jobs Panel UI, toast notifications, and
// server-side image + chat generation dispatch.
//
// New in this revision
// ─────────────────────
//  • generateChatBackend()  — submits a full chat turn to /api/generate-chat
//    and returns a job_id immediately.  The browser tab can be closed; the
//    backend keeps running and streams chunks back via SSE.
//  • SSE handles chat-chunk / chat-done / chat-error / chat-tool-calls events.
//  • Reconnect logic: on page load, if a "chat" job for the current chat_id
//    is still running, the SSE listener re-attaches to /api/jobs/{id}/stream
//    so the bubble picks up exactly where it left off.
//
// Depends on: config.js  (OLLAMA_BASE, IMG_API_MODE, IMG_API_BASE)
//             main.js    (BACKEND_AVAILABLE, CLIENT_ID,
//                         backendHeaders, currentAbortController)
//             image.js   (imgDbLoad, imgDbAdd, addImageToGallery,
//                         imgSortDesc, imgModelSel, imgGenerateBtn,
//                         imgStopBtn, imgSpinner, imgError,
//                         setImgStatus, getImgSize)
//             chat.js    (_chatOnBackendChunk, _chatOnBackendDone,
//                         _chatOnBackendError, _chatOnBackendToolCalls)
//
// Load order in index.html:  … → image.js → backend.js → …

(async function initBackend() {
  if (window.location.protocol === 'file:') return;
  // A single fast health check is unreliable over cellular/tunnel
  // connections — one slow first request (cold TLS handshake through a
  // Cloudflare tunnel, DNS, etc.) used to permanently mark the backend
  // unavailable for the rest of the page's life, silently disabling every
  // direct-call fallback in ollama.js/settings.js for that whole session.
  // Retry a couple of times with growing timeouts before giving up.
  // Tightened from [3000, 5000, 8000] (16s worst case) to [2000, 4000] (6s
  // worst case): /api/health is same-origin to this page — it never crosses
  // Ollama, Zoraxy, or any tunnel — so it answers almost instantly whenever
  // the backend process is actually up. The longer chain only ever delayed
  // discovering that it wasn't.
  let healthy = false;
  for (const timeout of [2000, 4000]) {
    try {
      const r = await fetch('/api/health', { signal: AbortSignal.timeout(timeout) });
      if (r.ok) { healthy = true; break; }
    } catch {}
  }
  if (!healthy) return;
  try {
    BACKEND_AVAILABLE = true;
    document.getElementById('jobs-panel-btn')?.classList.remove('hidden');

    // Apply initial visual state of the backend toggle to the jobs-panel button
    _backendToggleApply();

    await syncBackendJobs();
    startSseListener();
    // Defer reconnect check by one task tick so restoreChat() (async IndexedDB
    // read) has finished painting the history before we append a new bubble.
    setTimeout(() => _reconnectPendingChatJob(), 0);
  } catch {}
})();

// ── Backend chat toggle (Alt+click on the Server Jobs button) ─
// Syncs the jobs-panel button appearance to USE_BACKEND_CHAT.
// When OFF the button is dimmed; a strikethrough CSS pseudo-element
// makes the state obvious without adding any extra UI.
(function _injectBackendToggleStyles() {
  if (document.getElementById('_backend-toggle-styles')) return;
  const s = document.createElement('style');
  s.id = '_backend-toggle-styles';
  s.textContent = `
    #jobs-panel-btn.backend-off {
      opacity: 0.45;
      position: relative;
    }
    #jobs-panel-btn.backend-off::after {
      content: '';
      position: absolute;
      left: 50%; top: 50%;
      width: 1.5px; height: 130%;
      background: var(--text-muted);
      transform: translate(-50%, -50%) rotate(45deg);
      border-radius: 1px;
      pointer-events: none;
    }
  `;
  document.head.appendChild(s);
})();

function _backendToggleApply() {
  const btn = document.getElementById('jobs-panel-btn');
  if (!btn) return;
  const on = typeof USE_BACKEND_CHAT !== 'undefined' && USE_BACKEND_CHAT;
  btn.classList.toggle('backend-off', !on);
  // Keep the base title; append status hint
  btn.title = on
    ? 'Server Jobs  (Alt+click to disable backend processing)'
    : 'Server Jobs  (backend processing OFF — Alt+click to re-enable)';
}

// ── Backend: sync completed jobs into IndexedDB + gallery ────
let _serverPendingJobs = new Set();

// Job ids currently being polled directly by generateImageForToolBackend()
// (the generate_image chat tool). The generic 'done' SSE handler below calls
// syncBackendJobs() for every finished image job, which would otherwise race
// with our own poll — auto-adding the image to the gallery (and deleting the
// job server-side) before generateImageForToolBackend() gets a chance to read
// it back, defeating the "opt-in only" gallery design. Excluded here instead.
const _toolPendingImageJobIds = new Set();

function _updatePendingStatus() {
  const n = _serverPendingJobs.size;
  if (n > 0) setImgStatus(`${n} job${n > 1 ? 's' : ''} running on server…`, 'busy');
}

async function syncBackendJobs() {
  try {
    const r = await fetch('/api/jobs', { headers: { 'X-Client-ID': getEffectiveClientId() } });
    if (!r.ok) return;
    const { jobs } = await r.json();
    const existing = new Set((await imgDbLoad().catch(() => [])).map(e => e.id));

    _serverPendingJobs = new Set(
      jobs.filter(j => j.status === 'pending' || j.status === 'running').map(j => j.id)
    );
    _updatePendingStatus();
    jpUpdateBtnDot();

    // Only sync completed IMAGE jobs into the gallery (chat/file jobs have no b64).
    // Excludes jobs the generate_image tool is polling itself (see
    // _toolPendingImageJobIds above) — those are opt-in to the gallery only via
    // the "Save to gallery" button on the inline chat card.
    const done = jobs.filter(j =>
      j.status === 'done' && j.job_type === 'image' &&
      !existing.has(j.id) && !_toolPendingImageJobIds.has(j.id)
    );
    for (const j of done) {
      let full = await fetch(`/api/jobs/${j.id}`, { headers: { 'X-Client-ID': getEffectiveClientId() } }).then(r => r.json()).catch(() => null);
      if (!full?.b64) {
        await new Promise(res => setTimeout(res, 800));
        full = await fetch(`/api/jobs/${j.id}`, { headers: { 'X-Client-ID': getEffectiveClientId() } }).then(r => r.json()).catch(() => null);
      }
      if (!full?.b64) continue;
      const entry = {
        id: j.id, b64: full.b64, prompt: j.prompt, model: j.model,
        size: j.size, genTime: j.gen_time || '', ts: Math.round((j.finished || j.created) * 1000)
      };
      await imgDbAdd(entry).catch(() => {});
      addImageToGallery(entry, imgSortDesc);
      fetch(`/api/jobs/${j.id}`, { method: 'DELETE', headers: { 'X-Client-ID': getEffectiveClientId() } }).catch(() => {});
    }
  } catch (e) { console.warn('[backend sync]', e); }
}

// ── Backend: SSE listener for live job updates ───────────────
function startSseListener() {
  if (_sseSource) return;
  _sseSource = new EventSource(`/api/events?cid=${encodeURIComponent(getEffectiveClientId())}`);
  _sseSource.onmessage = async e => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }

    // corrector.js submits its one-shot jobs with this reserved chat_id so
    // they're never mistaken for a real chat session here — the corrector
    // handles its own job stream independently (see _correctViaBackend in
    // corrector.js), this listener just needs to not also forward those
    // events into chat.js's bubble-update hooks below.
    const _isCorrectorJob = ev.chat_id === (typeof CORRECTOR_JOB_CHAT_ID !== 'undefined' ? CORRECTOR_JOB_CHAT_ID : '__corrector__');

    // ── CHAT events (new backend-first path) ──────────────────

    if (ev.type === 'chat-chunk') {
      const _chunkLen = (ev.chunk || '').length;
      const _thinkLen = (ev.thinking || '').length;
      // console.log('[DEBUG SSE] chat-chunk job='+ev.job_id+' _backendJobId='+_backendJobId+' chunk='+_chunkLen+' think='+_thinkLen+' streamActive='+(_backendJobStreamActive&&_backendJobStreamActive.has(ev.job_id)));
      // Skip if this job is being handled by a per-job stream (_attachJobStream)
      // to avoid double-delivering chunks on secondary tabs.
      if (typeof _backendJobStreamActive !== 'undefined' &&
          _backendJobStreamActive.has(ev.job_id)) { console.warn('[DEBUG SSE] SKIPPED: in streamActive set'); return; }
      // Skip if this tab has no active backend job (e.g. a secondary observer tab
      // that hasn't sent a request — it should use _attachJobStream instead).
      // This mismatch already covers corrector jobs too, since their job_id
      // never equals chat.js's _backendJobId.
      if (typeof _backendJobId === 'undefined' || _backendJobId !== ev.job_id) { console.warn('[DEBUG SSE] SKIPPED: jobId mismatch _backendJobId='+_backendJobId); return; }
      if (typeof _chatOnBackendChunk === 'function') {
        _chatOnBackendChunk(ev.job_id, ev.chat_id, ev.chunk, ev.thinking || "");
      }
      return;
    }

    if (ev.type === 'chat-tool-start') {
      if (typeof _chatOnBackendToolStart === 'function' && !_isCorrectorJob) {
        _chatOnBackendToolStart(ev.job_id, ev.chat_id, ev.calls || []);
      }
      return;
    }

    if (ev.type === 'chat-tool-image-job') {
      if (typeof _chatOnBackendToolImageJob === 'function' && !_isCorrectorJob) {
        _chatOnBackendToolImageJob(ev.job_id, ev.chat_id, ev.sub_job_id);
      }
      return;
    }

    if (ev.type === 'chat-tool-calls') {
      if (typeof _chatOnBackendToolCalls === 'function' && !_isCorrectorJob) {
        _chatOnBackendToolCalls(ev.job_id, ev.chat_id, ev.tool_summaries || [], ev.images || []);
      }
      return;
    }

    if (ev.type === 'chat-done') {
      _serverPendingJobs.delete(ev.job_id);
      delete _jpProgress[ev.job_id];
      if (_serverPendingJobs.size === 0) _jpStopCountdown();
      try {
        const full = await fetch(`/api/jobs/${ev.job_id}`, { headers: { 'X-Client-ID': getEffectiveClientId() } })
          .then(r => r.json());
        if (typeof _chatOnBackendDone === 'function' && !_isCorrectorJob) {
          _chatOnBackendDone(ev.job_id, ev.chat_id, full.reply || '', full.final_messages || [], full.gen_time || '', full.raw_stats || null);
        }
        // Auto-delete chat jobs — but only if the server saved no jarvis_files.
        // If files were saved, keep the job record so the user can still access
        // them via /api/jobs/{id}/files.  Jobs with files are left for manual
        // cleanup (or the "Clear done" button in the Jobs panel).
        // (Applies to corrector jobs too — they're job_type "chat" under the
        // hood, so the same auto-delete bookkeeping is the right behavior.)
        if (!full.jarvis_files || full.jarvis_files.length === 0) {
          fetch(`/api/jobs/${ev.job_id}`, { method: 'DELETE', headers: { 'X-Client-ID': getEffectiveClientId() } }).catch(() => {});
        }
      } catch (err) {
        console.warn('[backend chat-done]', err);
        if (typeof _chatOnBackendError === 'function' && !_isCorrectorJob) {
          _chatOnBackendError(ev.job_id, ev.chat_id, 'Failed to retrieve result from server');
        }
      }
      jpRefreshIfOpen();
      jpUpdateBtnDot();
      return;
    }

    if (ev.type === 'chat-error') {
      _serverPendingJobs.delete(ev.job_id);
      delete _jpProgress[ev.job_id];
      if (_serverPendingJobs.size === 0) _jpStopCountdown();
      if (typeof _chatOnBackendError === 'function' && !_isCorrectorJob) {
        _chatOnBackendError(ev.job_id, ev.chat_id, ev.error || 'Server error');
      }
      jpRefreshIfOpen();
      jpUpdateBtnDot();
      _updatePendingStatus();
      return;
    }

    // ── IMAGE / shared events ─────────────────────────────────

    if (ev.type === 'done') {
      _serverPendingJobs.delete(ev.job_id);
      delete _jpProgress[ev.job_id];
      if (_serverPendingJobs.size === 0) _jpStopCountdown();
      await syncBackendJobs();
      jpRefreshIfOpen();
      setImgStatus('Image ready ✓', 'done');
      setTimeout(() => { if (_serverPendingJobs.size === 0) setImgStatus(''); }, 3000);

    } else if (ev.type === 'error') {
      _serverPendingJobs.delete(ev.job_id);
      delete _jpProgress[ev.job_id];
      if (_serverPendingJobs.size === 0) _jpStopCountdown();
      if (ev.job_type === 'chat' && typeof _chatOnBackendError === 'function') {
        _chatOnBackendError(ev.job_id, ev.chat_id, ev.error || 'Server error');
      } else {
        setImgStatus('Server error: ' + ev.error, '');
      }
      jpRefreshIfOpen();
      _updatePendingStatus();
      jpUpdateBtnDot();

    } else if (ev.type === 'status' && ev.status === 'running') {
      _serverPendingJobs.add(ev.job_id);
      _updatePendingStatus();
      jpUpdateBtnDot();
      jpRefreshIfOpen();

    } else if (ev.type === 'progress') {
      _jpProgress[ev.job_id] = { ..._jpProgress[ev.job_id], ...ev };
      const prog = _jpProgress[ev.job_id];
      if (prog.step != null && prog.steps_total > 0 && prog.step > 0 && prog.elapsed != null) {
        const secPerStep = prog.elapsed / prog.step;
        const remaining  = Math.max(0, secPerStep * (prog.steps_total - prog.step));
        prog._deadline   = Date.now() + remaining * 1000;
        _jpStartCountdown();
      }
      _jpApplyElapsed(ev.job_id, prog);
      if (_serverPendingJobs.has(ev.job_id)) {
        const n = _serverPendingJobs.size;
        const stepInfo = (prog.step != null && prog.steps_total > 0)
          ? ` · Step ${prog.step}/${prog.steps_total}` : '';
        setImgStatus(`${n} job${n > 1 ? 's' : ''} running on server…${stepInfo}`, 'busy');
      }

    } else if (ev.type === 'cancelled') {
      _serverPendingJobs.delete(ev.job_id);
      delete _jpProgress[ev.job_id];
      if (_serverPendingJobs.size === 0) _jpStopCountdown();
      // Route to the right handler based on what we know about the job
      // (excluding corrector jobs — see _isCorrectorJob above).
      if (ev.chat_id !== undefined && !_isCorrectorJob && typeof _chatOnBackendError === 'function') {
        _chatOnBackendError(ev.job_id, ev.chat_id, '[Generation cancelled by server]');
      }
      jpRefreshIfOpen();
      jpUpdateBtnDot();
      _updatePendingStatus();
    }
  };
  _sseSource.onerror = () => {};
}

// ── Reconnect: re-attach to an in-flight chat job on page load ───────────────
// If a chat job was submitted before the tab was closed, it's still running on
// the server.  We detect this from the job list and call the per-job stream
// endpoint to replay all chunks produced so far and then continue live.
async function _reconnectPendingChatJob() {
  try {
    const r = await fetch('/api/jobs', { headers: { 'X-Client-ID': getEffectiveClientId() } });
    if (!r.ok) return;
    const { jobs } = await r.json();

    // Find chat jobs that are still pending/running
    const active = jobs.filter(j =>
      j.job_type === 'chat' &&
      (j.status === 'pending' || j.status === 'running')
    );

    for (const j of active) {
      _serverPendingJobs.add(j.id);
      jpUpdateBtnDot();

      // Notify chat.js that there's an in-flight job to reconnect to.
      // chat.js will call _attachJobStream(job_id, chat_id) once it has
      // set up a bubble for the reconnect.
      if (typeof _chatOnBackendReconnect === 'function') {
        _chatOnBackendReconnect(j.id, j.chat_id || '');
      }
    }

    // ── Handle chat jobs that FINISHED while the tab was closed ──────────────
    // These have status === 'done' but were never delivered to the frontend
    // because the SSE connection was gone. Fetch the full reply and inject it
    // into the conversation now, then delete the server-side job as normal.
    const doneChatJobs = jobs.filter(j =>
      j.job_type === 'chat' && j.status === 'done'
    );

    for (const j of doneChatJobs) {
      try {
        const full = await fetch(`/api/jobs/${j.id}`, {
          headers: { 'X-Client-ID': getEffectiveClientId() }
        }).then(r => r.json());

        if (typeof _chatOnBackendDone === 'function') {
          _chatOnBackendDone(
            j.id,
            j.chat_id || '',
            full.reply        || '',
            full.final_messages || [],
            full.gen_time     || '',
            full.raw_stats    || null
          );
        }
        // Auto-delete exactly as the live SSE path does
        fetch(`/api/jobs/${j.id}`, {
          method: 'DELETE',
          headers: { 'X-Client-ID': getEffectiveClientId() }
        }).catch(() => {});
      } catch (err) {
        console.warn('[backend reconnect done-job]', j.id, err);
      }
    }
  } catch (e) {
    console.warn('[backend reconnect]', e);
  }
}

// ── Per-job stream: replays buffered chunks then continues live ──────────────
// Called by chat.js after it creates a placeholder bubble for a reconnecting job.
function _attachJobStream(job_id, chat_id) {
  const es = new EventSource(`/api/jobs/${encodeURIComponent(job_id)}/stream`);
  es.onmessage = async e => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }

    if (ev.type === 'chat-chunk') {
      if (typeof _chatOnBackendChunk === 'function')
        _chatOnBackendChunk(job_id, chat_id, ev.chunk, ev.thinking || "");
      return;
    }
    if (ev.type === 'chat-tool-start') {
      if (typeof _chatOnBackendToolStart === 'function')
        _chatOnBackendToolStart(job_id, chat_id, ev.calls || []);
      return;
    }
    if (ev.type === 'chat-tool-image-job') {
      if (typeof _chatOnBackendToolImageJob === 'function')
        _chatOnBackendToolImageJob(job_id, chat_id, ev.sub_job_id);
      return;
    }
    if (ev.type === 'chat-tool-calls') {
      if (typeof _chatOnBackendToolCalls === 'function')
        _chatOnBackendToolCalls(job_id, chat_id, ev.tool_summaries || [], ev.images || []);
      return;
    }
    if (ev.type === 'chat-done') {
      _serverPendingJobs.delete(job_id);
      delete _jpProgress[job_id];
      if (_serverPendingJobs.size === 0) _jpStopCountdown();
      if (typeof _backendJobStreamActive !== 'undefined') _backendJobStreamActive.delete(job_id);
      try {
        const full = await fetch(`/api/jobs/${job_id}`, { headers: { 'X-Client-ID': getEffectiveClientId() } })
          .then(r => r.json());
        if (typeof _chatOnBackendDone === 'function')
          _chatOnBackendDone(job_id, chat_id, full.reply || '', full.final_messages || [], full.gen_time || '', full.raw_stats || null);
        fetch(`/api/jobs/${job_id}`, { method: 'DELETE', headers: { 'X-Client-ID': getEffectiveClientId() } }).catch(() => {});
      } catch (err) {
        if (typeof _chatOnBackendError === 'function')
          _chatOnBackendError(job_id, chat_id, 'Failed to retrieve result from server');
      }
      jpRefreshIfOpen();
      jpUpdateBtnDot();
      es.close();
      return;
    }
    if (ev.type === 'chat-error' || ev.type === 'error' || ev.type === 'cancelled') {
      _serverPendingJobs.delete(job_id);
      if (typeof _backendJobStreamActive !== 'undefined') _backendJobStreamActive.delete(job_id);
      if (typeof _chatOnBackendError === 'function')
        _chatOnBackendError(job_id, chat_id, ev.error || ev.type);
      jpRefreshIfOpen();
      jpUpdateBtnDot();
      es.close();
    }
  };
  es.onerror = () => { es.close(); };
}

// ── Server Jobs Panel ─────────────────────────────────────────
const jpModal    = document.getElementById('jobs-panel-modal');
const jpList     = document.getElementById('jp-list');
const jpEmpty    = document.getElementById('jp-empty');
const jpBtnDot   = document.getElementById('jp-btn-dot');
const jpPanelBtn = document.getElementById('jobs-panel-btn');

const STATUS_COLORS = { pending: 'var(--text-muted)', running: 'var(--accent)', done: 'var(--green)', error: 'var(--red)', cancelled: 'var(--text-muted)' };
const STATUS_LABELS = { pending: '⏳ pending', running: '⚙️ running', done: '✓ done', error: '✗ error', cancelled: '⊘ cancelled' };

const _jpProgress = {};

let _jpCountdownTimer = null;

function _jpStartCountdown() {
  if (_jpCountdownTimer) return;
  _jpCountdownTimer = setInterval(() => {
    for (const [jobId, prog] of Object.entries(_jpProgress)) {
      if (prog._deadline == null) continue;
      _jpApplyElapsed(jobId, prog);
    }
  }, 1000);
}

function _jpStopCountdown() {
  if (!_jpCountdownTimer) return;
  clearInterval(_jpCountdownTimer);
  _jpCountdownTimer = null;
}

// ── Toast notifications ───────────────────────────────────────
function showToast(html, durationMs = 7000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  container.appendChild(el);
  const dismiss = () => {
    el.classList.add('toast-out');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 600);
  };
  const timer = setTimeout(dismiss, durationMs);
  el.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
}

function jpUpdateBtnDot() {
  if (!jpBtnDot) return;
  const n = _serverPendingJobs.size;
  if (n > 0) {
    jpBtnDot.textContent = n > 99 ? '99+' : n;
    if (jpBtnDot.classList.contains('hidden')) {
      jpBtnDot.classList.remove('hidden');
      jpBtnDot.classList.add('badge-pop');
      jpBtnDot.addEventListener('animationend', () => jpBtnDot.classList.remove('badge-pop'), { once: true });
    } else {
      jpBtnDot.classList.remove('badge-pop');
      void jpBtnDot.offsetWidth;
      jpBtnDot.classList.add('badge-pop');
      jpBtnDot.addEventListener('animationend', () => jpBtnDot.classList.remove('badge-pop'), { once: true });
    }
  } else {
    jpBtnDot.classList.add('hidden');
    jpBtnDot.textContent = '';
  }
}

function jpRefreshIfOpen() {
  if (jpModal && !jpModal.classList.contains('hidden')) jpRender();
}

async function jpRender() {
  if (!jpList) return;
  try {
    const r = await fetch('/api/jobs', { headers: { 'X-Client-ID': getEffectiveClientId() } });
    if (!r.ok) return;
    const { jobs } = await r.json();

    if (!jobs.length) {
      jpList.innerHTML = '';
      if (jpEmpty) jpEmpty.style.display = '';
      return;
    }
    if (jpEmpty) jpEmpty.style.display = 'none';

    const sorted = [...jobs].sort((a, b) => b.created - a.created);
    jpList.innerHTML = sorted.map(j => {
      const isChatJob  = j.job_type === 'chat';
      const promptText = isChatJob
        ? `Chat turn · ${j.model || ''}`.trim()
        : (j.prompt || '');
      const prompt   = promptText.length > 80 ? promptText.slice(0, 80) + '…' : (promptText || '—');
      const typeTag  = isChatJob
        ? `<span style="font-size:10px;color:var(--accent);margin-left:4px;">💬 chat</span>`
        : '';
      const color    = STATUS_COLORS[j.status] || 'var(--text-muted)';
      const label    = STATUS_LABELS[j.status] || j.status;
      const isActive = j.status === 'pending' || j.status === 'running';
      const cancelBtn = isActive
        ? `<button class="icon-btn jp-cancel-btn" data-job-id="${j.id}" style="font-size:10px;color:var(--red);padding:2px 5px;border:1px solid color-mix(in srgb,var(--red) 40%,transparent);border-radius:4px" title="Cancel this job">cancel</button>`
        : '';
      // Give the span an id for the job's whole active lifetime (pending
      // AND running), not just once it's running — _jpApplyElapsed() can
      // only write into an element that already exists, and 'progress' SSE
      // events can start arriving before this row's REST-fetched status
      // catches up to 'running'. Previously the pending-state span had no
      // id at all, so any progress events landing in that window were
      // silently dropped (data still recorded in _jpProgress, just nothing
      // to render into) — the cause of progress appearing to "start" partway
      // through a job, or not at all for very fast jobs.
      const elapsedSpan = isActive
        ? `<span id="jp-elapsed-${j.id}" style="color:var(--text-muted);font-weight:400">${j.status === 'pending' ? ' · queued' : ''}</span>`
        : '';
      const statusExtra = j.status === 'done' ? ` · ${j.gen_time || ''}` : '';
      return `<div id="jp-row-${j.id}" class="sp-section" style="padding:0.6rem 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--text-muted)">${j.model ? j.model.split('/').pop() : ''}${!isChatJob ? ' · ' + (j.size || '') : ''}${typeTag}</span>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
            <span style="font-size:11px;font-weight:600;color:${color};white-space:nowrap">${label}${statusExtra}${elapsedSpan}</span>
            ${cancelBtn}
          </div>
        </div>
        <div style="font-size:12px;margin-top:3px;color:var(--text)">${prompt}</div>
        ${j.status === 'error' ? `<div style="font-size:10px;color:var(--red);margin-top:2px">${j.error || ''}</div>` : ''}
      </div>`;
    }).join('');

    for (const [jobId, prog] of Object.entries(_jpProgress)) {
      _jpApplyElapsed(jobId, prog);
    }
  } catch (e) { console.warn('[jp]', e); }
}

function jpOpen()  { if (!jpModal) return; jpModal.classList.remove('hidden'); jpRender(); }
function jpClose() { jpModal?.classList.add('hidden'); }

// Shared toggle action used by both Alt+click and long-press
function _backendToggle() {
  USE_BACKEND_CHAT = !USE_BACKEND_CHAT;
  localStorage.setItem('jarvis_use_backend_chat', USE_BACKEND_CHAT);
  _backendToggleApply();
}

// Desktop: Alt+click toggles; plain click opens panel
jpPanelBtn?.addEventListener('click', e => {
  if (e.altKey) {
    e.preventDefault();
    _backendToggle();
    return;
  }
  jpOpen();
});

// Mobile: long-press (300 ms) toggles; short tap opens panel
if (jpPanelBtn) {
  let _lpTimer = null;
  let _lpFired = false;

  jpPanelBtn.addEventListener('touchstart', e => {
    _lpFired = false;
    _lpTimer = setTimeout(() => {
      _lpFired = true;
      _backendToggle();
      // Brief haptic pulse if the browser supports it
      navigator.vibrate?.(40);
    }, 300);
  }, { passive: true });

  jpPanelBtn.addEventListener('touchend', e => {
    clearTimeout(_lpTimer);
    // If long-press already fired, swallow the synthetic click so the
    // panel doesn't open immediately after the toggle
    if (_lpFired) e.preventDefault();
  });

  jpPanelBtn.addEventListener('touchmove', () => {
    // Finger moved — cancel so scrolling doesn't accidentally toggle
    clearTimeout(_lpTimer);
  }, { passive: true });
}
document.getElementById('jp-close-btn')?.addEventListener('click', jpClose);
document.getElementById('jp-refresh-btn')?.addEventListener('click', jpRender);

function _jpApplyElapsed(jobId, prog) {
  const el = document.getElementById(`jp-elapsed-${jobId}`);
  if (!el || prog == null) return;
  if (prog._deadline == null) { el.textContent = ''; return; }
  const remaining = Math.max(0, (prog._deadline - Date.now()) / 1000);
  const fmtTime   = s => s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
  el.textContent = ` · Step ${prog.step}/${prog.steps_total} · ~${fmtTime(remaining)} remaining`;
}

jpList?.addEventListener('click', async e => {
  const btn = e.target.closest('.jp-cancel-btn');
  if (!btn) return;
  const jobId = btn.dataset.jobId;
  if (!jobId) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST', headers: { 'X-Client-ID': getEffectiveClientId() } });
    if (!r.ok) { btn.disabled = false; btn.textContent = 'cancel'; }
  } catch { btn.disabled = false; btn.textContent = 'cancel'; }
});

document.getElementById('jp-clear-done-btn')?.addEventListener('click', async () => {
  try {
    const r = await fetch('/api/jobs', { headers: { 'X-Client-ID': getEffectiveClientId() } });
    const { jobs } = await r.json();
    const clearable = jobs.filter(j => ['done', 'error', 'cancelled'].includes(j.status));

    // Sync any completed image jobs into gallery before clearing
    const doneImageJobs = clearable.filter(j => j.status === 'done' && j.job_type === 'image');
    if (doneImageJobs.length) {
      const existing = new Set((await imgDbLoad().catch(() => [])).map(e => e.id));
      for (const j of doneImageJobs) {
        if (existing.has(j.id)) continue;
        const full = await fetch(`/api/jobs/${j.id}`, { headers: { 'X-Client-ID': getEffectiveClientId() } })
          .then(res => res.json()).catch(() => null);
        if (!full?.b64) continue;
        const entry = {
          id: j.id, b64: full.b64, prompt: j.prompt, model: j.model,
          size: j.size, genTime: j.gen_time || '',
          ts: Math.round((j.finished || j.created) * 1000)
        };
        await imgDbAdd(entry).catch(() => {});
        addImageToGallery(entry, imgSortDesc);
      }
    }
    await Promise.all(
      clearable.map(j => fetch(`/api/jobs/${j.id}`, { method: 'DELETE', headers: { 'X-Client-ID': getEffectiveClientId() } }))
    );
    clearable.forEach(j => delete _jpProgress[j.id]);
    jpRender();
  } catch {}
});
jpModal?.addEventListener('click', e => { if (e.target === jpModal) jpClose(); });

// ── Backend: submit an IMAGE job and return immediately ──────
async function generateImageBackend(prompt) {
  imgBusy = true;
  imgGenerateBtn.classList.add('hidden');
  imgStopBtn.classList.remove('hidden');
  imgSpinner.classList.add('visible');
  imgError.style.display = 'none';

  const model   = imgModelSel.value;
  const size    = getImgSize();
  const seedEl  = document.getElementById('img-seed');
  const stepsEl = document.getElementById('img-steps');
  const seedVal  = seedEl  ? parseInt(seedEl.value)  : NaN;
  const stepsVal = stepsEl ? parseInt(stepsEl.value) : NaN;

  try {
    const payload = {
      prompt, model, size,
      api_mode:    IMG_API_MODE,
      ollama_base: IMG_API_BASE || OLLAMA_BASE,
      seed:        (!isNaN(seedVal)  && seedVal  > 0) ? seedVal  : null,
      steps:       (!isNaN(stepsVal) && stepsVal > 0) ? stepsVal : null,
    };
    const r = await fetch('/api/generate', { method: 'POST', headers: backendHeaders(), body: JSON.stringify(payload) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { job_id } = await r.json();
    _serverPendingJobs.add(job_id);
    jpUpdateBtnDot();
    showToast(`Job <span class="toast-accent">#${job_id.slice(0, 8)}</span> has been queued.`, 5000);
    setImgStatus('Job queued — generating on server, you can close this tab', 'busy');
  } catch (e) {
    imgError.textContent = 'Backend error: ' + e.message;
    imgError.style.display = 'block';
    setImgStatus('');
  } finally {
    imgBusy = false;
    imgGenerateBtn.classList.remove('hidden');
    imgStopBtn.classList.add('hidden');
    imgSpinner.classList.remove('visible');
  }
}

// ── Backend: image generation for the generate_image chat tool ───
// Same /api/generate job submission as generateImageBackend(), but awaited:
// the chat tool-call loop needs the finished image before it can continue
// the conversation, so this polls the job record directly instead of
// firing-and-forgetting. Deliberately does NOT reuse the shared SSE listener
// above (startSseListener) for its completion signal — that listener's
// 'done' handling is generic/global (syncBackendJobs()) and isn't keyed to a
// specific job_id in a way this could safely await, so a direct poll avoids
// any risk of double-consuming or missing the event.
// Returns { b64, genTime } on success; throws on error/timeout/cancellation.
async function generateImageForToolBackend(prompt, width, height, model, size) {
  const payload = {
    prompt, model, size,
    api_mode:    IMG_API_MODE,
    ollama_base: IMG_API_BASE || OLLAMA_BASE,
    seed: null, steps: null,
  };
  const r = await fetch('/api/generate', { method: 'POST', headers: backendHeaders(), body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const { job_id } = await r.json();
  _serverPendingJobs.add(job_id);
  _toolPendingImageJobIds.add(job_id);
  jpUpdateBtnDot();

  const started    = Date.now();
  const TIMEOUT_MS = 180000, POLL_MS = 1200;
  try {
    while (Date.now() - started < TIMEOUT_MS) {
      await new Promise(res => setTimeout(res, POLL_MS));
      const job = await fetch(`/api/jobs/${job_id}`, { headers: { 'X-Client-ID': getEffectiveClientId() } })
        .then(res => res.ok ? res.json() : null).catch(() => null);
      if (!job) continue;
      if (job.status === 'error')     throw new Error(job.error || 'Server error generating image');
      if (job.status === 'cancelled') throw new Error('Generation was cancelled on the server');
      if (job.status === 'done' && job.b64) {
        fetch(`/api/jobs/${job_id}`, { method: 'DELETE', headers: { 'X-Client-ID': getEffectiveClientId() } }).catch(() => {});
        return { b64: job.b64, genTime: job.gen_time || '' };
      }
    }
    throw new Error('Image generation timed out.');
  } finally {
    _serverPendingJobs.delete(job_id);
    _toolPendingImageJobIds.delete(job_id);
    jpUpdateBtnDot();
  }
}

// ── Backend: submit a CHAT turn and return immediately ────────
// The full chat turn (messages, model, options, tools) is handed off to the
// server. The server streams chunks back via SSE; the frontend bubble updates
// in real-time exactly as it would from a direct Ollama connection.
// If the tab is closed, the server keeps generating; on reopen the frontend
// reconnects via _reconnectPendingChatJob() → _attachJobStream().
//
// Returns the job_id string on success, or null on submission failure.
//
// Parameters:
//   chatId    — stable ID for this chat session (from main.js CHAT_ID)
//   messages  — full OpenAI-format messages array (system + history)
//   model     — model name string
//   options   — RUNTIME_OPTIONS (temperature, num_ctx, …)
//   tools     — OpenAI-format tool schemas from ToolsEngine.buildSchemas()
//   toolsConfig — raw TOOLS_CONFIG so the server can execute HTTP tools
//   apiConfig — { flavor, base } so the server uses the right LLM endpoint
//   ragToolConfig — optional { rag_tool_collection, rag_tool_qdrant_url,
//                   rag_tool_embed_model, rag_tool_embed_flavor } from
//                   rag.js's getRagToolBackendPayload(), present only when
//                   the chat-mode RAG selector is set to "Tool". Lets the
//                   server execute rag_search tool calls itself, since the
//                   job may keep running after the tab is closed.
async function generateChatBackend(chatId, messages, model, options, tools, toolsConfig, apiConfig, ragToolConfig) {
  try {
    // Extract 'think' from options so the server receives it as a dedicated
    // top-level flag.  This keeps numeric model options (temperature, num_ctx,
    // …) clean and matches how Ollama's /api/chat accepts the think parameter.
    const { think, ...modelOptions } = options || {};
    const payload = {
      chat_id:     chatId,
      messages,
      model,
      options:     modelOptions,
      think:       think === true,   // explicit boolean; false when toggle is off
      tools:       tools       || [],
      tools_config: toolsConfig || [],
      // Anti-runaway cap for sequential tool-call rounds (Settings → Tool
      // Calling). 0 = unlimited. Falls back to 5 if the global is missing.
      max_tool_rounds: (typeof MAX_TOOL_ROUNDS === 'number' && MAX_TOOL_ROUNDS >= 0) ? MAX_TOOL_ROUNDS : 5,
      api_flavor:  (apiConfig && apiConfig.flavor) || API_FLAVOR,
      ollama_base: (apiConfig && apiConfig.base)   || OLLAMA_BASE,
      // Image-gen settings for the server-side generate_image tool (see
      // _execute_generate_image_tool in server.py) — mirrors Settings →
      // Image so a tool call mid-chat uses the same model/API the Image
      // mode gallery would.
      image_model:       (typeof imgModelSel !== 'undefined' && imgModelSel) ? imgModelSel.value : '',
      image_api_mode:    typeof IMG_API_MODE !== 'undefined' ? IMG_API_MODE : 'openai',
      image_ollama_base: (typeof IMG_API_BASE !== 'undefined' && IMG_API_BASE) || OLLAMA_BASE,
      image_default_width:  (typeof IMG_TOOL_DEFAULT_WIDTH  !== 'undefined' && IMG_TOOL_DEFAULT_WIDTH)  || 512,
      image_default_height: (typeof IMG_TOOL_DEFAULT_HEIGHT !== 'undefined' && IMG_TOOL_DEFAULT_HEIGHT) || 512,
      ...(ragToolConfig || {}),
    };
    const r = await fetch('/api/generate-chat', {
      method:  'POST',
      headers: backendHeaders(),
      body:    JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { job_id } = await r.json();
    _serverPendingJobs.add(job_id);
    jpUpdateBtnDot();
    return job_id;
  } catch (e) {
    console.warn('[backend] generateChatBackend failed:', e);
    return null;
  }
}

