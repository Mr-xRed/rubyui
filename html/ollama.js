// ══ OLLAMA NATIVE API FLAVOR ═════════════════════════════════
// All Ollama-specific network logic (/api/*).
//
// This file is loaded BEFORE main.js.  Every function inside
// OllamaAPI only references globals from main.js (OLLAMA_BASE,
// modelSel, thinkToggle, RUNTIME_OPTIONS, IMG_API_BASE, API.*,
// spPull*, checkOllama, spRefresh, spFmtBytesDown …) inside
// function bodies — they are resolved lazily at call-time, long
// after main.js has finished executing.

const OllamaAPI = {

  // ── Direct-fetch with backend-proxy fallback ───────────────────
  // Tries `base` directly AND the backend proxy at the same time on the
  // FIRST call for a given base, taking whichever answers first and
  // remembering which one won. Every later call for that same base reuses
  // the remembered path directly — one fetch, not two. This matters
  // because checkOllama() fires fetchModelCaps() for every model in
  // parallel (Promise.all): racing both legs for EVERY one of those at
  // once means N models → 2N simultaneous connections across two origins,
  // which queues up behind the browser's per-origin connection cap and is
  // most of where the multi-second delay comes from. If the remembered
  // path ever fails on a later call, we drop it and re-race once to
  // rediscover (self-heals if the network changes mid-session).
  _preferredPath: new Map(), // base -> 'direct' | 'proxy'

  async _fetchJson(base, path, opts = {}) {
    // Timeouts tightened from 5000/8000ms: those ceilings were the dominant
    // source of the multi-second "models take forever to show up" symptom —
    // a metadata call (/api/tags, /api/show) that's actually working never
    // needs more than ~1s on a LAN or a warm tunnel. 2500/4500 still gives a
    // cold connection plenty of room while making genuine failures surface
    // fast instead of silently eating most of a 10-second wait.
    const tryDirect = () => fetch(`${base}${path}`, { signal: AbortSignal.timeout(2500), ...opts })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    const tryProxy = () => fetch(`/api/ollama-proxy${path}?base=${encodeURIComponent(base)}`, { signal: AbortSignal.timeout(4500), ...opts })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} (via backend proxy)`); return r.json(); });

    const remembered = OllamaAPI._preferredPath.get(base);
    if (remembered) {
      try {
        return await (remembered === 'direct' ? tryDirect() : tryProxy());
      } catch {
        OllamaAPI._preferredPath.delete(base); // fall through and re-race below
      }
    }

    return new Promise((resolve, reject) => {
      let pending = 2;
      let directErr = null;
      const onSuccess = (data, isDirect) => {
        OllamaAPI._preferredPath.set(base, isDirect ? 'direct' : 'proxy');
        resolve(data);
      };
      const onFail = (err, isDirect) => {
        if (isDirect) directErr = err;
        pending--;
        if (pending === 0) reject(directErr || err);
      };
      tryDirect().then(d => onSuccess(d, true)).catch(err => onFail(err, true));
      tryProxy().then(d => onSuccess(d, false)).catch(err => onFail(err, false));
    });
  },

  // ── Model listing ─────────────────────────────────────────────
  // Returns [{name, size, modified_at, details}]
  async listModels() {
    const d = await OllamaAPI._fetchJson(OLLAMA_BASE, '/api/tags');
    return d.models || [];
  },

  // ── Model capabilities ────────────────────────────────────────
  // Returns Set<string> from /api/show
  async modelCaps(name) {
    try {
      const d = await OllamaAPI._fetchJson(OLLAMA_BASE, '/api/show', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name })
      });
      return new Set(Array.isArray(d.capabilities) ? d.capabilities : []);
    } catch {
      return new Set();
    }
  },

  // ── Inference request builders ────────────────────────────────
  // `tools` — optional OpenAI-format tools[] from ToolsEngine.buildSchemas().
  // Ollama accepts the same schema format; tool_choice defaults to 'auto'.
  chatRequest(messages, tools) {
    const body = {
      model:   modelSel.value,
      messages,
      stream:  true,
      think:   thinkToggle.checked,
      options: RUNTIME_OPTIONS
    };
    if (tools?.length) {
      body.tools       = tools;
      body.tool_choice = 'auto';
    }
    return { url: `${OLLAMA_BASE}/api/chat`, body };
  },

  correctorRequest(systemPrompt, userPrompt) {
    return {
      url:  `${OLLAMA_BASE}/api/generate`,
      body: {
        model:   modelSel.value,
        system:  systemPrompt,
        prompt:  userPrompt,
        stream:  true,
        think:   thinkToggle.checked,
        options: RUNTIME_OPTIONS
      }
    };
  },

  // ── Streaming chunk parsers (NDJSON) ──────────────────────────
  // `toolCalls` is non-null only on the final done chunk when the model
  // chose to call a tool instead of (or in addition to) generating text.
  parseChatChunk(line) {
    const o = JSON.parse(line);
    return {
      content:   o.message?.content    || '',
      thinking:  o.message?.thinking   || '',
      toolCalls: o.message?.tool_calls || null,
      done:      !!o.done
    };
  },

  parseCorrectorChunk(line) {
    const o = JSON.parse(line);
    return {
      response: o.response || '',
      thinking: o.thinking || '',
      done: !!o.done
    };
  },

  // ── Response stats ────────────────────────────────────────────
  // Ollama's final chunk carries duration fields in nanoseconds.
  parseStats(raw /*, timing — not used for Ollama */) {
    const s = {};
    if (raw.eval_count && raw.eval_duration)
      s.tps = (raw.eval_count / (raw.eval_duration / 1e9)).toFixed(1);
    if (raw.prompt_eval_count) s.inputTokens  = raw.prompt_eval_count;
    if (raw.eval_count)        s.outputTokens = raw.eval_count;
    if (raw.load_duration)     s.loadTime  = (raw.load_duration  / 1e9).toFixed(2) + 's';
    if (raw.total_duration)    s.totalTime = (raw.total_duration / 1e9).toFixed(2) + 's';
    return Object.keys(s).length ? s : null;
  },

  // ── Model management ──────────────────────────────────────────
  async unloadModel(name) {
    await fetch(`${OLLAMA_BASE}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: name, keep_alive: 0 })
    });
  },

  async deleteModel(name) {
    const res = await fetch(`${OLLAMA_BASE}/api/delete`, {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name })
    });
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
  },

  async runningModels() {
    try {
      const d = await OllamaAPI._fetchJson(OLLAMA_BASE, '/api/ps');
      return d.models || [];
    } catch {
      return [];
    }
  },

  async serverVersion() {
    try {
      return await OllamaAPI._fetchJson(OLLAMA_BASE, '/api/version');
    } catch {
      return {};
    }
  },

  checkUrl(base) {
    return `${base}/api/tags`;
  },

  // ── Image model listing (capability-filtered) ─────────────────
  // Fetches /api/tags + /api/show for each model.
  // Returns [{name}] where capability 'image' is present.
  // Falls back to all models for older Ollama versions that don't report caps.
  async listImgModels(imgBase) {
    const d  = await OllamaAPI._fetchJson(imgBase, '/api/tags');
    const all = d.models || [];

    const capResults = await Promise.allSettled(all.map(async m => {
      const sd = await OllamaAPI._fetchJson(imgBase, '/api/show', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: m.name })
      });
      return { name: m.name, size: m.size || 0, details: m.details || {}, caps: new Set(Array.isArray(sd.capabilities) ? sd.capabilities : []) };
    }));

    const succeeded   = capResults.filter(r => r.status === 'fulfilled');
    const imageModels = succeeded
      .filter(r => r.value.caps.has('image'))
      .map(({ value: v }) => ({ name: v.name, size: v.size, details: v.details }));

    if (imageModels.length) return imageModels;

    // Only fall back to "show everything" when every capability check
    // actually succeeded and genuinely none reported 'image' — the
    // legitimate case this fallback exists for (an older Ollama that
    // doesn't report capabilities at all). If some/all checks merely
    // failed to load, that's a different problem and showing every chat
    // model as if it were an image model would just be wrong — surface
    // the failure instead so it's visibly broken rather than silently so.
    if (succeeded.length === all.length) {
      return all.map(m => ({ name: m.name, size: m.size || 0, details: m.details || {} }));
    }
    throw new Error(`Could not check ${all.length - succeeded.length} of ${all.length} models — try again`);
  },

  // ── Simple tag list (no cap filtering) ───────────────────────
  // Used by the status panel image-API section.
  async fetchTagsList(base) {
    const d = await OllamaAPI._fetchJson(base, '/api/tags');
    return (d.models || []).map(m => ({ name: m.name, size: m.size || 0, details: m.details || {} }));
  },

  // Parses one NDJSON line from /api/generate, updating the accumulator and
  // firing onStep for progress events. Shared by the live-stream path and
  // the buffered proxy-fallback path below.
  _consumeGenerateLine(line, onStep, acc) {
    if (!line.trim()) return;
    try {
      const o = JSON.parse(line);
      if (typeof o.completed === 'number' && typeof o.total === 'number') onStep(o.completed, o.total);
      if (o.done) {
        if (o.total_duration) acc.nativeGenTime = (o.total_duration / 1e9).toFixed(1) + 's';
        if (o.image) acc.b64Images.push(o.image);
      }
    } catch {}
  },

  // ── Native image generation (/api/generate streaming) ─────────
  // Tries direct first (preserves live per-step progress via onStep).
  // Deliberately SEQUENTIAL, not raced like _fetchJson's read-only calls —
  // generation is expensive and not idempotent, so racing direct+proxy
  // concurrently could trigger two real generations on the same GPU. A
  // direct CORS/Access rejection happens before the request ever reaches
  // Ollama, so falling back after it fails doesn't double up anything.
  // The proxy fallback is buffered server-side (see /api/ollama-proxy),
  // so progress arrives all at once near the end instead of incrementally
  // — the image still generates and displays correctly, you just lose the
  // live progress bar in that fallback case.
  async generateNative(body, signal, onStep) {
    const base = IMG_API_BASE || OLLAMA_BASE;
    try {
      return await OllamaAPI._generateNativeDirect(base, body, signal, onStep);
    } catch (directErr) {
      try {
        return await OllamaAPI._generateNativeViaProxy(base, body, signal, onStep);
      } catch {
        throw directErr; // surface the original, more descriptive error
      }
    }
  },

  async _generateNativeDirect(base, body, signal, onStep) {
    const res = await fetch(`${base}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body:    JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(errText || `HTTP ${res.status}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const acc = { b64Images: [], nativeGenTime: null };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) OllamaAPI._consumeGenerateLine(line, onStep, acc);
    }

    if (!acc.b64Images.length) throw new Error('No image returned by the model.');
    return acc;
  },

  // Buffered fallback through our own backend — no live streaming (the
  // whole NDJSON body arrives in one response), but works off-LAN where
  // direct access to `base` is blocked.
  async _generateNativeViaProxy(base, body, signal, onStep) {
    const res = await fetch(`/api/ollama-proxy/api/generate?base=${encodeURIComponent(base)}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body:    JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(errText || `HTTP ${res.status} (via backend proxy)`);
    }
    const text = await res.text();
    const acc  = { b64Images: [], nativeGenTime: null };
    for (const line of text.split('\n')) OllamaAPI._consumeGenerateLine(line, onStep, acc);

    if (!acc.b64Images.length) throw new Error('No image returned by the model.');
    return acc;
  },

  // ── Pull / download model (streaming NDJSON) ─────────────────
  // Manages the full pull UI directly; all DOM refs (spPullBarFill,
  // spPullPctEl, etc.) and helpers (spSetPullState, spFmtBytesDown,
  // checkOllama, spRefresh) live in main.js and are resolved at call-time.
  async spPullModel(name) {
    spPullAbort = new AbortController();
    spSetPullState(true);
    spPullProgress.classList.remove('hidden');
    spPullBarFill.style.width = '0%';
    spPullPctEl.textContent   = '';
    spPullDetail.textContent  = '';
    spPullSetStatus('Connecting…');

    // Track layers: digest → {completed, total}
    const layers = {};
    let lastDigest = '';

    try {
      const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  spPullAbort.signal,
        body:    JSON.stringify({ name, stream: true })
      });

      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        throw new Error(msg || `HTTP ${res.status}`);
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }

          if (obj.error) throw new Error(obj.error);

          const status = obj.status || '';

          // Layer download progress
          if (obj.digest && typeof obj.total === 'number') {
            lastDigest = obj.digest;
            layers[obj.digest] = { completed: obj.completed || 0, total: obj.total };
          }

          // Compute overall progress across all seen layers
          let totalBytes = 0, completedBytes = 0;
          for (const l of Object.values(layers)) {
            totalBytes     += l.total;
            completedBytes += l.completed;
          }

          if (totalBytes > 0) {
            const pct = Math.min(99, Math.round((completedBytes / totalBytes) * 100));
            spPullBarFill.style.width = pct + '%';
            spPullPctEl.textContent   = pct + '%';
            spPullDetail.textContent  = spFmtBytesDown(completedBytes, totalBytes);
          } else {
            // Indeterminate — pulse to ~30 % to show activity
            spPullBarFill.style.width = '30%';
            spPullPctEl.textContent   = '';
          }

          // Status label — shorten digest to first 12 chars
          const shortDigest = lastDigest ? lastDigest.replace('sha256:', '').slice(0, 12) : '';
          const displayStatus = status.startsWith('pulling ') && shortDigest
            ? `pulling ${shortDigest}…`
            : status;
          spPullSetStatus(displayStatus);

          if (status === 'success') {
            spPullBarFill.style.width = '100%';
            spPullPctEl.textContent   = '100%';
            spPullSetStatus('Model pulled successfully', 'sp-done');
            spPullDetail.textContent  = '';
            await checkOllama();
            await spRefresh();
            spPullInput.value = '';
            setTimeout(() => spPullProgress.classList.add('hidden'), 3000);
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        spPullSetStatus('Pull cancelled', '');
        spPullBarFill.style.width = '0%';
        spPullPctEl.textContent   = '';
        setTimeout(() => spPullProgress.classList.add('hidden'), 2000);
      } else {
        spPullSetStatus('Error: ' + e.message, 'sp-error');
        spPullBarFill.style.width = '0%';
        spPullPctEl.textContent   = '';
      }
    } finally {
      spSetPullState(false);
      spPullAbort = null;
    }
  }
};
