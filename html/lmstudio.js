// ══ LM STUDIO NATIVE API FLAVOR ══════════════════════════════
// All LM Studio-specific network logic (/api/v1/* for management,
// /v1/* for inference).
//
// Loaded BEFORE main.js.  References to shared globals (OLLAMA_BASE,
// modelSel, thinkToggle, RUNTIME_OPTIONS, API.*, spPull*, checkOllama,
// spRefresh …) inside function bodies are resolved lazily at call-time.

const LMStudioAPI = {

  // Maps model key → instance_id of its first loaded instance.
  // Populated by runningModels() so that unloadModel() can send the
  // correct instance_id without needing a separate argument.
  _instanceIdCache: new Map(),

  // ── Direct-fetch with backend-proxy fallback ───────────────────
  // Same mechanism as OllamaAPI._fetchJson (see ollama.js for the full
  // rationale): races direct vs our own /api/ollama-proxy on the first
  // call for a given base, remembers which one won, and reuses that path
  // directly on later calls so only the first one ever pays for both.
  // The proxy endpoint is a generic passthrough — it doesn't care which
  // API flavor's path it's forwarding — so this works unchanged for
  // LM Studio's /api/v1/* paths too.
  _preferredPath: new Map(), // base -> 'direct' | 'proxy'

  async _fetchJson(base, path, opts = {}) {
    const tryDirect = () => fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000), ...opts })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    const tryProxy = () => fetch(`/api/ollama-proxy${path}?base=${encodeURIComponent(base)}`, { signal: AbortSignal.timeout(8000), ...opts })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} (via backend proxy)`); return r.json(); });

    const remembered = LMStudioAPI._preferredPath.get(base);
    if (remembered) {
      try {
        return await (remembered === 'direct' ? tryDirect() : tryProxy());
      } catch {
        LMStudioAPI._preferredPath.delete(base); // fall through and re-race below
      }
    }

    return new Promise((resolve, reject) => {
      let pending = 2;
      let directErr = null;
      const onSuccess = (data, isDirect) => {
        LMStudioAPI._preferredPath.set(base, isDirect ? 'direct' : 'proxy');
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
  // Fetches /api/v1/models and populates API._lmsCapsCache /
  // API._lmsReasoningOpts so that modelCaps() and request-builders
  // can inspect capabilities without an extra round-trip.
  async listModels() {
    const d = await LMStudioAPI._fetchJson(OLLAMA_BASE, '/api/v1/models');

    API._lmsCapsCache.clear();
    API._lmsReasoningOpts.clear();

    const result = [];
    for (const m of (d.models || [])) {
      if (m.type === 'embedding') continue;     // skip embedding models

      const caps = new Set(['completion']);
      if (m.capabilities?.vision) caps.add('vision');

      // reasoning is an object: { allowed_options: ["off","on"], default: "on" }
      // A model supports user-controlled thinking if "on" is in allowed_options.
      const ropts = m.capabilities?.reasoning?.allowed_options;
      if (Array.isArray(ropts) && ropts.includes('on')) {
        caps.add('thinking');
        API._lmsReasoningOpts.set(m.key, ropts);  // cache raw options for request building
      }
      API._lmsCapsCache.set(m.key, caps);

      result.push({
        name:               m.key,
        size:               m.size_bytes || 0,
        modified_at:        '',
        details:            { parameter_size: m.params_string || '' },
        max_context_length: m.max_context_length || 0,
        loaded_instances:   m.loaded_instances   || []
      });
    }
    return result;
  },

  // ── Inference request builders ────────────────────────────────
  // Both use the LM Studio native /api/v1/chat endpoint so that the
  // `reasoning` field is actually honoured.  /v1/chat/completions silently
  // ignores it, causing the model to always use its default (usually "on").
  //
  // chatRequest accepts an optional prevResponseId for multi-turn chaining:
  // LM Studio maintains conversation history server-side, so only the newest
  // user message is sent as `input` on turns after the first.
  chatRequest(messages, prevResponseId) {
    // Separate system prompt from the conversation turns
    let systemPrompt = null;
    let conv = messages;
    if (conv[0]?.role === 'system') {
      systemPrompt = conv[0].content;
      conv = conv.slice(1);
    }

    // Only the newest user message is sent; prior context lives server-side.
    const lastMsg = conv[conv.length - 1] || { role: 'user', content: '' };

    let input;
    if (lastMsg.images?.length) {
      // Vision: typed-array input with text part(s) followed by image part(s)
      input = [];
      if (lastMsg.content) input.push({ type: 'text', content: String(lastMsg.content) });
      for (const b64 of lastMsg.images) {
        let mime = 'image/jpeg';
        if (b64.startsWith('iVBOR'))     mime = 'image/png';
        else if (b64.startsWith('R0lG')) mime = 'image/gif';
        else if (b64.startsWith('UklG')) mime = 'image/webp';
        input.push({ type: 'image', data_url: `data:${mime};base64,${b64}` });
      }
    } else {
      input = String(lastMsg.content || '');
    }

    const body = {
      model:          modelSel.value,
      input,
      stream:         true,
      temperature:    RUNTIME_OPTIONS.temperature,
      top_p:          RUNTIME_OPTIONS.top_p,
      context_length: RUNTIME_OPTIONS.num_ctx,
      store:          true
    };
    if (RUNTIME_OPTIONS.repeat_penalty != null) body.repeat_penalty = RUNTIME_OPTIONS.repeat_penalty;
    if (RUNTIME_OPTIONS.top_k != null) body.top_k = RUNTIME_OPTIONS.top_k;

    // First turn → include system_prompt.  Later turns → chain via response_id.
    if (prevResponseId) {
      body.previous_response_id = prevResponseId;
    } else if (systemPrompt) {
      body.system_prompt = systemPrompt;
    }

    const opts = API._lmsReasoningOpts.get(modelSel.value);
    if (opts?.length) body.reasoning = thinkToggle.checked ? opts[opts.length - 1] : opts[0];
    return { url: `${OLLAMA_BASE}/api/v1/chat`, body, lmsNative: true };
  },

  correctorRequest(systemPrompt, userPrompt) {
    const body = {
      model:          modelSel.value,
      input:          userPrompt,
      stream:         true,
      temperature:    RUNTIME_OPTIONS.temperature,
      top_p:          RUNTIME_OPTIONS.top_p,
      context_length: RUNTIME_OPTIONS.num_ctx,
      store:          false   // single-shot; no need to persist on the server
    };
    if (systemPrompt) body.system_prompt = systemPrompt;
    if (RUNTIME_OPTIONS.repeat_penalty != null) body.repeat_penalty = RUNTIME_OPTIONS.repeat_penalty;
    if (RUNTIME_OPTIONS.top_k != null) body.top_k = RUNTIME_OPTIONS.top_k;
    const opts = API._lmsReasoningOpts.get(modelSel.value);
    if (opts?.length) body.reasoning = thinkToggle.checked ? opts[opts.length - 1] : opts[0];
    return { url: `${OLLAMA_BASE}/api/v1/chat`, body, lmsNative: true };
  },

  // ── Streaming chunk parsers (SSE) ─────────────────────────────
  // LM Studio uses delta.reasoning for the thinking field.
  parseChatChunk(line) {
    const data = line.startsWith('data: ') ? line.slice(6) : line;
    if (data.trim() === '[DONE]') return { content: '', thinking: '', done: true };
    const o    = JSON.parse(data);
    const done = o.choices?.[0]?.finish_reason != null;
    // LM Studio uses delta.reasoning; fall back to delta.reasoning_content (DeepSeek style)
    const reasoning = o.choices?.[0]?.delta?.reasoning
                   || o.choices?.[0]?.delta?.reasoning_content
                   || '';
    if (reasoning) return { content: '', thinking: reasoning, done };
    const { content, thinking } = API._splitThink(o.choices?.[0]?.delta?.content || '');
    return { content, thinking, done };
  },

  parseCorrectorChunk(line) {
    const data = line.startsWith('data: ') ? line.slice(6) : line;
    if (data.trim() === '[DONE]') return { response: '', thinking: '', done: true };
    const o    = JSON.parse(data);
    const done = o.choices?.[0]?.finish_reason != null;
    const reasoning = o.choices?.[0]?.delta?.reasoning
                   || o.choices?.[0]?.delta?.reasoning_content
                   || '';
    if (reasoning) return { response: '', thinking: reasoning, done };
    const { content, thinking } = API._splitThink(o.choices?.[0]?.delta?.content || '');
    return { response: content, thinking, done };
  },

  // ── Native response parser (/api/v1/chat, non-streaming) ──────
  // Walks the output[] array returned by the native endpoint and
  // separates visible content from reasoning blocks.
  // Also surfaces response_id for multi-turn chaining and the stats
  // object for renderStatsBar.
  //
  // NOTE: item.content follows OpenAI Responses API format — it may be
  // a plain string OR an array of typed parts, e.g.:
  //   reasoning item: [{ type: "thinking", thinking: "..." }]
  //   message item:   [{ type: "output_text", text: "..." }]
  // Both forms are handled below.
  parseLmsNativeResponse(data) {
    // Extracts text from a content field that may be a string or a typed array.
    function extractText(c) {
      if (!c) return '';
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return c.map(p => p.text || p.thinking || p.content || '').join('');
      }
      return '';
    }

    let content  = '';
    let thinking = '';
    for (const item of (data.output || [])) {
      if (item.type === 'message')        content  += extractText(item.content);
      else if (item.type === 'reasoning') thinking += extractText(item.content);
    }

    // Fallback: some models return thinking inside <think> tags embedded
    // in the message content rather than as a separate reasoning item.
    if (!thinking && content) {
      const split = API._splitThink(content);
      content  = split.content;
      thinking = split.thinking;
    }

    return {
      content,
      thinking,
      responseId: data.response_id || null,
      stats:      data.stats       || null
    };
  },

  // ── Native streaming chunk parser (/api/v1/chat, stream:true) ─
  // LM Studio native SSE format (raw JSON lines, no "data: " prefix):
  //   {"type":"message.start"}
  //   {"type":"message.delta","content":"..."}    ← incremental text
  //   {"type":"reasoning.delta","content":"..."}  ← incremental thinking
  //   {"type":"message.end"}
  //   {"type":"chat.end","result":{ output[], stats, response_id }}
  parseNativeChatChunk(line) {
    const raw = line.startsWith('data: ') ? line.slice(6) : line;
    if (raw.trim() === '[DONE]') return { content: '', thinking: '', done: true, stats: null, responseId: null };

    let o;
    try { o = JSON.parse(raw); } catch { return { content: '', thinking: '', done: false, stats: null, responseId: null }; }

    // Incremental content delta
    if (o.type === 'message.delta')
      return { content: o.content || '', thinking: '', done: false, stats: null, responseId: null };

    // Incremental thinking delta (reasoning-capable models)
    if (o.type === 'reasoning.delta')
      return { content: '', thinking: o.content || '', done: false, stats: null, responseId: null };

    // Final chunk — carries stats and response_id; content already streamed above
    if (o.type === 'chat.end' && o.result) {
      return {
        content:    '',
        thinking:   '',
        done:       true,
        stats:      o.result.stats       || null,
        responseId: o.result.response_id || null
      };
    }

    // message.start / message.end / unknown — nothing to emit
    return { content: '', thinking: '', done: false, stats: null, responseId: null };
  },

  // ── Response stats ────────────────────────────────────────────
  // LM Studio may return a native `stats` object (via /api/v0/) or a
  // standard OpenAI-compat `usage` block (via /v1/).  Both are handled.
  parseStats(raw, timing) {
    const s = {};
    if (raw.stats) {
      // LM Studio native stats object
      const st = raw.stats;
      if (st.tokens_per_second)                   s.tps          = st.tokens_per_second.toFixed(1);
      if (st.input_tokens)                        s.inputTokens  = st.input_tokens;
      if (st.total_output_tokens)                 s.outputTokens = st.total_output_tokens;
      if (st.time_to_first_token_seconds != null) s.ttft         = st.time_to_first_token_seconds.toFixed(3) + 's';
      if (st.model_load_time_seconds)             s.loadTime     = st.model_load_time_seconds.toFixed(2) + 's';
    } else if (raw.usage) {
      // OpenAI-compat usage block (enriched with client-side timing)
      if (raw.usage.prompt_tokens)     s.inputTokens  = raw.usage.prompt_tokens;
      if (raw.usage.completion_tokens) s.outputTokens = raw.usage.completion_tokens;
      if (timing) {
        if (timing.totalSec > 0 && raw.usage.completion_tokens)
          s.tps     = (raw.usage.completion_tokens / timing.totalSec).toFixed(1);
        if (timing.ttftSec !== null) s.ttft = timing.ttftSec.toFixed(3) + 's';
        s.totalTime = timing.totalSec.toFixed(2) + 's';
      }
    }
    return Object.keys(s).length ? s : null;
  },

  // ── Model management ──────────────────────────────────────────
  async unloadModel(name) {
    // LM Studio requires instance_id, not the model name/key.
    // We look it up from the cache populated by runningModels().
    const instanceId = LMStudioAPI._instanceIdCache.get(name) || name;
    const r = await fetch(`${OLLAMA_BASE}/api/v1/models/unload`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ instance_id: instanceId })
    });
    if (!r.ok) {
      const msg = await r.text().catch(() => '');
      throw new Error(msg || `HTTP ${r.status}`);
    }
  },

  async runningModels() {
    const d = await LMStudioAPI._fetchJson(OLLAMA_BASE, '/api/v1/models').catch(() => ({}));

    // Rebuild the instance-id cache so unloadModel() can send the correct id.
    LMStudioAPI._instanceIdCache.clear();
    const result = [];
    for (const m of (d.models || [])) {
      if (m.type === 'embedding' || !m.loaded_instances?.length) continue;
      // Cache the first instance_id for this model key.
      const firstInst = m.loaded_instances[0];
      const instId    = firstInst?.instance_id || firstInst?.id || m.key;
      LMStudioAPI._instanceIdCache.set(m.key, instId);
      result.push({ name: m.key, size_vram: 0, size: 0, details: {} });
    }
    return result;
  },

  checkUrl(base) {
    return `${base}/api/v1/models`;
  },

  // ── Download model ────────────────────────────────────────────
  // LM Studio download: POST /api/v1/models/download, then poll
  // /api/v1/models/download/status until the model appears in /api/v1/models.
  //
  // Manages the full pull UI directly; all DOM refs (spPullBarFill,
  // spPullPctEl, etc.) and helpers (spSetPullState, checkOllama,
  // spRefresh …) live in main.js and are resolved at call-time.
  async spPullModel(name) {
    spPullAbort = new AbortController();
    spSetPullState(true);
    spPullProgress.classList.remove('hidden');
    spPullBarFill.style.width = '5%';
    spPullPctEl.textContent   = '';
    spPullDetail.textContent  = '';
    spPullSetStatus('Requesting download…');

    try {
      const res = await fetch(`${OLLAMA_BASE}/api/v1/models/download`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  spPullAbort.signal,
        body:    JSON.stringify({ model: name })
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        throw new Error(msg || `HTTP ${res.status}`);
      }

      // Capture the job_id returned by the download initiation.
      const initData = await res.json().catch(() => ({}));
      const jobId    = initData.job_id || null;

      spPullSetStatus('Downloading…');

      // Poll /api/v1/models/download/status/:job_id for progress.
      // Falls back to model-list detection when job_id is absent.
      let attempts = 0;
      const maxAttempts = 600; // 10 min at 1 s intervals

      const poll = async () => {
        if (spPullAbort?.signal.aborted) return;
        attempts++;
        if (attempts > maxAttempts) {
          spPullSetStatus('Download timed out — check LM Studio directly.', 'sp-error');
          spSetPullState(false); spPullAbort = null;
          return;
        }

        if (jobId) {
          try {
            const sr = await fetch(
              `${OLLAMA_BASE}/api/v1/models/download/status/${jobId}`,
              { signal: AbortSignal.timeout(3000) }
            );
            if (sr.ok) {
              const sd = await sr.json().catch(() => ({}));

              // Compute percentage from byte counts when available.
              if (sd.total_size_bytes > 0) {
                const done = sd.downloaded_bytes || 0;
                const pct  = Math.min(99, Math.round((done / sd.total_size_bytes) * 100));
                spPullBarFill.style.width = pct + '%';
                spPullPctEl.textContent   = pct + '%';
                spPullDetail.textContent  = spFmtBytesDown(done, sd.total_size_bytes)
                  + (sd.bytes_per_second
                      ? '  ·  ' + spFmtBytes(sd.bytes_per_second) + '/s'
                      : '');
              } else {
                // No byte totals yet — show an animated indeterminate bar.
                const pct = Math.min(60, 5 + attempts);
                spPullBarFill.style.width = pct + '%';
                spPullPctEl.textContent   = '';
              }

              if (sd.status === 'completed') {
                spPullBarFill.style.width = '100%';
                spPullPctEl.textContent   = '100%';
                spPullSetStatus('Model downloaded successfully', 'sp-done');
                spPullDetail.textContent  = '';
                await checkOllama();
                await spRefresh();
                spPullInput.value = '';
                setTimeout(() => spPullProgress.classList.add('hidden'), 3000);
                spSetPullState(false); spPullAbort = null;
                return;
              }

              if (sd.status === 'failed') {
                spPullSetStatus('Download failed — check LM Studio directly.', 'sp-error');
                spSetPullState(false); spPullAbort = null;
                return;
              }

              // Map LM Studio status string to human-readable label.
              const statusLabel = { downloading: 'Downloading…', paused: 'Paused…' }[sd.status] || sd.status || 'Downloading…';
              spPullSetStatus(statusLabel);
            }
          } catch { /* ignore transient poll errors */ }
        } else {
          // No job_id: show an indeterminate bar and rely on model-list check below.
          const pct = Math.min(60, 5 + attempts);
          spPullBarFill.style.width = pct + '%';
        }

        // Completion guard: model appears in the installed list.
        try {
          const models = await API.listModels();
          if (models.some(m => m.name === name)) {
            spPullBarFill.style.width = '100%';
            spPullPctEl.textContent   = '100%';
            spPullSetStatus('Model downloaded successfully', 'sp-done');
            spPullDetail.textContent  = '';
            await checkOllama();
            await spRefresh();
            spPullInput.value = '';
            setTimeout(() => spPullProgress.classList.add('hidden'), 3000);
            spSetPullState(false); spPullAbort = null;
            return;
          }
        } catch {}

        setTimeout(poll, 1000);
      };
      setTimeout(poll, 1000);

    } catch (e) {
      if (e.name === 'AbortError') {
        spPullSetStatus('Download cancelled', '');
        spPullBarFill.style.width = '0%';
        spPullPctEl.textContent   = '';
        setTimeout(() => spPullProgress.classList.add('hidden'), 2000);
      } else {
        spPullSetStatus('Error: ' + e.message, 'sp-error');
        spPullBarFill.style.width = '0%';
        spPullPctEl.textContent   = '';
      }
      spSetPullState(false); spPullAbort = null;
    }
  }
};
