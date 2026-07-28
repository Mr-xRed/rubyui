// ══ OPENAI-COMPATIBLE API FLAVOR ═════════════════════════════
// All OpenAI-compatible API-specific network logic (/v1/*).
//
// Loaded BEFORE main.js.  References to shared globals (OLLAMA_BASE,
// modelSel, RUNTIME_OPTIONS, API.*  …) inside function bodies are
// resolved lazily at call-time.

const OpenAIAPI = {

  // ── Direct-fetch with backend-proxy fallback ───────────────────
  // Same mechanism as OllamaAPI._fetchJson (see ollama.js for the full
  // rationale): races direct vs our own /api/ollama-proxy on the first
  // call for a given base, remembers which one won, and reuses that path
  // directly on later calls so only the first one ever pays for both.
  // The proxy endpoint is a generic passthrough — it doesn't care which
  // API flavor's path it's forwarding — so this works unchanged for the
  // OpenAI-compatible /v1/* paths too.
  _preferredPath: new Map(), // base -> 'direct' | 'proxy'

  async _fetchJson(base, path, opts = {}) {
    const tryDirect = () => fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000), ...opts })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    const tryProxy = () => fetch(`/api/ollama-proxy${path}?base=${encodeURIComponent(base)}`, { signal: AbortSignal.timeout(8000), ...opts })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} (via backend proxy)`); return r.json(); });

    const remembered = OpenAIAPI._preferredPath.get(base);
    if (remembered) {
      try {
        return await (remembered === 'direct' ? tryDirect() : tryProxy());
      } catch {
        OpenAIAPI._preferredPath.delete(base); // fall through and re-race below
      }
    }

    return new Promise((resolve, reject) => {
      let pending = 2;
      let directErr = null;
      const onSuccess = (data, isDirect) => {
        OpenAIAPI._preferredPath.set(base, isDirect ? 'direct' : 'proxy');
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
  // Standard /v1/models — no capability data available.
  async listModels() {
    API._lmsCapsCache.clear();
    const d = await OpenAIAPI._fetchJson(OLLAMA_BASE, '/v1/models');
    return (d.data || []).map(m => ({
      name:        m.id,
      size:        0,
      modified_at: m.created ? new Date(m.created * 1000).toISOString() : '',
      details:     {}
    }));
  },

  // ── Inference request builders ────────────────────────────────
  // `tools` — optional OpenAI-format tools[] from ToolsEngine.buildSchemas().
  chatRequest(messages, tools) {
    const oaiMessages = API._convertMessages(messages);
    const body = {
      model:          modelSel.value,
      messages:       oaiMessages,
      stream:         true,
      stream_options: { include_usage: true },
      temperature:    RUNTIME_OPTIONS.temperature,
      top_p:          RUNTIME_OPTIONS.top_p,
      max_tokens:     RUNTIME_OPTIONS.num_ctx
    };
    if (RUNTIME_OPTIONS.top_k != null) body.top_k = RUNTIME_OPTIONS.top_k;
    if (tools?.length) {
      body.tools       = tools;
      body.tool_choice = 'auto';
    }
    return { url: `${OLLAMA_BASE}/v1/chat/completions`, body };
  },

  correctorRequest(systemPrompt, userPrompt) {
    const msgs = [];
    if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
    msgs.push({ role: 'user', content: userPrompt });
    const body = {
      model:          modelSel.value,
      messages:       msgs,
      stream:         true,
      stream_options: { include_usage: true },
      temperature:    RUNTIME_OPTIONS.temperature,
      top_p:          RUNTIME_OPTIONS.top_p,
      max_tokens:     RUNTIME_OPTIONS.num_ctx
    };
    if (RUNTIME_OPTIONS.top_k != null) body.top_k = RUNTIME_OPTIONS.top_k;
    return { url: `${OLLAMA_BASE}/v1/chat/completions`, body };
  },

  // ── Streaming chunk parsers (SSE) ─────────────────────────────
  // `toolCallsDelta` — non-null when the delta carries partial tool_calls data.
  // chat.js accumulates these across chunks via API.accumulateToolCallDelta().
  parseChatChunk(line) {
    const data = line.startsWith('data: ') ? line.slice(6) : line;
    if (data.trim() === '[DONE]') return { content: '', thinking: '', done: true, toolCallsDelta: null };
    const o    = JSON.parse(data);
    const done = o.choices?.[0]?.finish_reason != null;
    const toolCallsDelta = o.choices?.[0]?.delta?.tool_calls || null;
    // Support delta.reasoning_content (DeepSeek API style)
    const reasoning = o.choices?.[0]?.delta?.reasoning
                   || o.choices?.[0]?.delta?.reasoning_content
                   || '';
    if (reasoning) return { content: '', thinking: reasoning, done, toolCallsDelta };
    const { content, thinking } = API._splitThink(o.choices?.[0]?.delta?.content || '');
    return { content, thinking, done, toolCallsDelta };
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

  // ── Response stats ────────────────────────────────────────────
  // Token counts come from the usage block; timing is client-side.
  parseStats(raw, timing) {
    if (!raw.usage) return null;
    const s = {};
    if (raw.usage.prompt_tokens)     s.inputTokens  = raw.usage.prompt_tokens;
    if (raw.usage.completion_tokens) s.outputTokens = raw.usage.completion_tokens;
    if (timing) {
      if (timing.totalSec > 0 && raw.usage.completion_tokens)
        s.tps     = (raw.usage.completion_tokens / timing.totalSec).toFixed(1);
      if (timing.ttftSec !== null) s.ttft = timing.ttftSec.toFixed(3) + 's';
      s.totalTime = timing.totalSec.toFixed(2) + 's';
    }
    return Object.keys(s).length ? s : null;
  },

  checkUrl(base) {
    return `${base}/v1/models`;
  },

  // ── Image model listing ───────────────────────────────────────
  // OpenAI-compat: GET /v1/models — no capability metadata, show all.
  async listImgModels(imgBase) {
    const d = await OpenAIAPI._fetchJson(imgBase, '/v1/models');
    return (d.data || []).map(m => ({ name: m.id }));
  },

  // ── Simple models list (for status panel) ────────────────────
  async fetchModelsList(base) {
    const d = await OpenAIAPI._fetchJson(base, '/v1/models');
    return (d.data || []).map(m => ({ name: m.id, size: 0, details: {} }));
  }
};
