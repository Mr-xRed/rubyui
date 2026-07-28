// ══ CORRECTOR.JS ═════════════════════════════════════════════
// Text corrector feature: streaming proofreader request,
// word-level diff renderer, and all corrector UI wiring.
//
// Depends on: config.js  (CORRECTOR_SYSTEM)
//             api.js     (API.correctorRequest, API.parseCorrectorChunk,
//                         API.resetStream)
//             main.js    (ensureModelLoaded, currentAbortController)
//
// Load order in index.html:  … → settings.js → corrector.js → …

// ── Corrector DOM refs ────────────────────────────────────────
const inputEl        = document.getElementById('input-text');
const outputEl       = document.getElementById('output-text');
const correctBtn     = document.getElementById('correct-btn');
const stopCorrectBtn = document.getElementById('stop-correct-btn');
const clearBtn       = document.getElementById('clear-btn');
const pasteBtn       = document.getElementById('paste-btn');
const copyBtn        = document.getElementById('copy-btn');
const corrSpinner    = document.getElementById('corr-spinner');
const corrError      = document.getElementById('corr-error');
const charCount      = document.getElementById('char-count');
const viewClean      = document.getElementById('view-clean');
const viewDiff       = document.getElementById('view-diff');

// ══ CORRECTOR ════════════════════════════════════════════════
let lastCorrected = '';
let lastInput = '';
let showDiff = false;

// ── Backend job state ─────────────────────────────────────────
// A reserved chat_id for corrector jobs submitted via generateChatBackend().
// It's never a real chat session, so backend.js's global SSE listener
// checks against it to skip calling chat.js's bubble-update hooks for
// corrector jobs — the corrector handles its own job stream directly via
// the EventSource opened in _correctViaBackend() below, fully independent
// of chat.js's active-job tracking.
const CORRECTOR_JOB_CHAT_ID = '__corrector__';
let _correctorJobId = null;
let _correctorEs    = null;

inputEl.addEventListener('input', () => {
  const len = inputEl.value.length;
  charCount.textContent = `${len} char${len !== 1 ? 's' : ''}`;
});

// ── Wire up the corrector think-bubble collapse ───────────────
document.getElementById('corr-think-header').addEventListener('click', () => {
  document.getElementById('corr-think').classList.toggle('think-collapsed');
});

async function correct() {
  const text = inputEl.value.trim();
  if (!text) return;

  await ensureModelLoaded();

  correctBtn.classList.add('hidden');
  stopCorrectBtn.classList.remove('hidden');
  corrSpinner.classList.add('visible');
  corrError.style.display = 'none';
  outputEl.innerHTML = '';
  lastCorrected = '';

  // Defensive cleanup if a previous backend stream was somehow left open
  // (shouldn't happen — the button is hidden while a correction runs —
  // but cheap insurance against a stale EventSource leaking).
  _correctorEs?.close();
  _correctorEs = null;
  _correctorJobId = null;

  // Reset think section
  const corrThink        = document.getElementById('corr-think');
  const corrThinkBody    = document.getElementById('corr-think-body');
  const corrThinkSpinner = document.getElementById('corr-think-spinner');
  corrThink.classList.add('hidden');
  corrThink.classList.remove('think-collapsed');
  corrThinkBody.textContent = '';
  const els = { corrThink, corrThinkBody, corrThinkSpinner };

  const prompt = `Text to correct:\n${text}`;

  // Route through the server job queue when backend processing is on —
  // this is the SAME USE_BACKEND_CHAT toggle chat.js uses (Alt+click the
  // Jobs panel button), so flipping it off for local tool calling also
  // keeps the corrector local, consistent with how the rest of the app
  // already treats that switch.
  const useBackend = typeof BACKEND_AVAILABLE   !== 'undefined' && BACKEND_AVAILABLE &&
                      typeof USE_BACKEND_CHAT    !== 'undefined' && USE_BACKEND_CHAT &&
                      typeof generateChatBackend === 'function';

  try {
    if (useBackend) await _correctViaBackend(text, prompt, els);
    else            await _correctDirect(text, prompt, els);
  } finally {
    correctBtn.classList.remove('hidden');
    stopCorrectBtn.classList.add('hidden');
    corrSpinner.classList.remove('visible');
    renderOutput(false);
    currentAbortController = null;
  }
}

// ── Direct path: stream straight from the browser to Ollama/LM Studio/OpenAI ──
// This is the original corrector flow, unchanged — used whenever backend
// processing is unavailable or disabled.
async function _correctDirect(text, prompt, { corrThink, corrThinkBody, corrThinkSpinner }) {
  currentAbortController = new AbortController();
  let thinkText = '';

  try {
    API.resetStream();
    const { url: _corrUrl, body: _corrBody, lmsNative: _lmsNative } = API.correctorRequest(CORRECTOR_SYSTEM, prompt);
    const res = await fetch(_corrUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  currentAbortController.signal,
      body:    JSON.stringify(_corrBody)
    });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          // LM Studio native format uses parseNativeChatChunk (message.delta / chat.end);
          // Ollama / OpenAI-compat use parseCorrectorChunk (SSE/OpenAI format).
          const chunk = _lmsNative
            ? LMStudioAPI.parseNativeChatChunk(line)
            : API.parseCorrectorChunk(line);
          // parseCorrectorChunk returns { response }; parseNativeChatChunk returns { content }
          const chunkText = chunk.response || chunk.content || '';
          if (chunk.thinking) {
            thinkText += chunk.thinking;
            if (thinkText) {
              corrThink.classList.remove('hidden');
              corrThinkSpinner.classList.add('visible');
              corrThinkBody.textContent = thinkText;
            }
          }
          if (chunkText) { lastCorrected += chunkText; renderOutput(true); }
        } catch {}
      }
    }
    lastInput = text;
    corrThinkSpinner.classList.remove('visible');
  } catch (e) {
    if (e.name === 'AbortError') {
      lastCorrected += ' [Correction interrupted]';
    } else {
      corrError.textContent = `Error: ${e.message}`;
      corrError.style.display = 'block';
      outputEl.innerHTML = '';
    }
    corrThinkSpinner.classList.remove('visible');
  }
}

// ── Backend path: submit as a one-shot server job, stream via its own SSE ──
// Reuses the exact same /api/generate-chat job machinery chat.js uses for
// real chat turns (a correction is just a single system+user turn with no
// history and no tools) — this is what lets the corrector survive a closed
// tab and keeps "Server Jobs" panel bookkeeping consistent across the app.
// Opens its OWN EventSource directly against this job's stream endpoint
// rather than going through backend.js's shared listener, so it never has
// to fight chat.js for ownership of an SSE connection or an active job id.
async function _correctViaBackend(text, prompt, { corrThink, corrThinkBody, corrThinkSpinner }) {
  let thinkText = '';

  const job_id = await generateChatBackend(
    CORRECTOR_JOB_CHAT_ID,
    [
      { role: 'system', content: CORRECTOR_SYSTEM },
      { role: 'user',   content: prompt }
    ],
    modelSel.value,
    { ...RUNTIME_OPTIONS, think: thinkToggle.checked },
    [],   // tools — the corrector never calls tools
    [],   // tools_config
    { flavor: API_FLAVOR, base: OLLAMA_BASE }
  );

  if (!job_id) {
    // Submission failed (offline backend, network hiccup, etc.) — fall
    // back to the direct path transparently instead of failing the turn.
    return _correctDirect(text, prompt, { corrThink, corrThinkBody, corrThinkSpinner });
  }

  _correctorJobId = job_id;

  const finish = () => {
    if (typeof _serverPendingJobs !== 'undefined') _serverPendingJobs.delete(job_id);
    if (typeof jpUpdateBtnDot === 'function') jpUpdateBtnDot();
    _correctorEs?.close();
    _correctorEs = null;
    _correctorJobId = null;
  };

  return new Promise(resolve => {
    _correctorEs = new EventSource(`/api/jobs/${encodeURIComponent(job_id)}/stream`);

    _correctorEs.onmessage = e => {
      let ev; try { ev = JSON.parse(e.data); } catch { return; }

      if (ev.type === 'chat-chunk') {
        if (ev.thinking) {
          thinkText += ev.thinking;
          corrThink.classList.remove('hidden');
          corrThinkSpinner.classList.add('visible');
          corrThinkBody.textContent = thinkText;
        }
        if (ev.chunk) { lastCorrected += ev.chunk; renderOutput(true); }
        return;
      }
      if (ev.type === 'chat-done') {
        lastInput = text;
        corrThinkSpinner.classList.remove('visible');
        finish();
        resolve();
        return;
      }
      if (ev.type === 'cancelled') {
        lastCorrected += ' [Correction interrupted]';
        corrThinkSpinner.classList.remove('visible');
        finish();
        resolve();
        return;
      }
      if (ev.type === 'chat-error' || ev.type === 'error') {
        corrError.textContent = `Error: ${ev.error || 'Server job failed'}`;
        corrError.style.display = 'block';
        corrThinkSpinner.classList.remove('visible');
        finish();
        resolve();
      }
    };

    _correctorEs.onerror = () => {
      // The connection to our own backend dropped mid-stream — surface it
      // rather than leaving the spinner running forever. If a partial
      // reply already streamed in, keep it rather than wiping the output.
      if (!lastCorrected) {
        corrError.textContent = 'Error: lost connection to the server job';
        corrError.style.display = 'block';
      }
      corrThinkSpinner.classList.remove('visible');
      finish();
      resolve();
    };
  });
}

function renderOutput(streaming = false) {
  if (!lastCorrected) return;
  if (showDiff && lastInput) {
    outputEl.innerHTML = buildDiff(lastInput, lastCorrected) + (streaming ? '<span class="stream-cursor"></span>' : '');
  } else {
    outputEl.textContent = lastCorrected;
    if (streaming) { const c = document.createElement('span'); c.className = 'stream-cursor'; outputEl.appendChild(c); }
  }
}

function buildDiff(a, b) {
  const wa = a.split(/(\s+)/), wb = b.split(/(\s+)/);
  const m = wa.length, n = wb.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = wa[i-1] === wb[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const ops = []; let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && wa[i-1] === wb[j-1]) { ops.push({ t: 'eq',  v: wb[j-1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { ops.push({ t: 'add', v: wb[j-1] }); j--; }
    else { ops.push({ t: 'del', v: wa[i-1] }); i--; }
  }
  ops.reverse();
  return ops.map(o => {
    const s = o.v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    if (o.t === 'eq')  return s;
    if (o.t === 'add') return `<span class="diff-added">${s}</span>`;
    if (o.t === 'del') return `<span class="diff-removed">${s}</span>`;
  }).join('');
}

// ── Event listeners ───────────────────────────────────────────
viewClean.addEventListener('click', () => { showDiff = false; viewClean.classList.add('active'); viewDiff.classList.remove('active'); renderOutput(false); });
viewDiff.addEventListener('click',  () => { showDiff = true;  viewDiff.classList.add('active');  viewClean.classList.remove('active'); renderOutput(false); });

// Ctrl/Cmd+Shift+Space → correct; Ctrl/Cmd+Shift+D → clear.
// Registered on the textarea directly so the shortcuts fire even when
// the browser or OS would intercept the same combo at the document level.
inputEl.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
  if (e.code === 'Space') { e.preventDefault(); e.stopPropagation(); correct(); }
  else if (e.code === 'KeyD') { e.preventDefault(); clearBtn.click(); }
});
correctBtn.addEventListener('click', correct);
stopCorrectBtn.addEventListener('click', () => {
  if (_correctorJobId) {
    fetch(`/api/jobs/${_correctorJobId}/cancel`, {
      method:  'POST',
      headers: { 'X-Client-ID': getEffectiveClientId() }
    }).catch(() => {});
  } else {
    currentAbortController?.abort();
  }
});
clearBtn.addEventListener('click', () => { inputEl.value = ''; charCount.textContent = '0 chars'; inputEl.focus(); });
pasteBtn.addEventListener('click', async () => {
  try { const t = await navigator.clipboard.readText(); inputEl.value = t; charCount.textContent = `${t.length} chars`; }
  catch { alert('Clipboard access denied.'); }
});
copyBtn.addEventListener('click', async () => {
  if (!lastCorrected) return;
  await navigator.clipboard.writeText(lastCorrected);
});

// ── Initial focus (desktop only) ──────────────────────────────
// Called here rather than from main.js because inputEl is local to
// this file and doesn't exist when main.js's init IIFE runs.
if (!isMobile() && currentMode === 'corrector') inputEl.focus();
