// ══ API.JS ═══════════════════════════════════════════════════
// The API abstraction layer — routes all network calls through
// the active flavour (OllamaAPI / LMStudioAPI / OpenAIAPI).
//
// Depends on: config.js (OLLAMA_BASE, API_FLAVOR)
//             ollama.js, lmstudio.js, openai.js (flavour objects,
//             resolved lazily at call-time so load order is safe)
//
// Load order in index.html:
//   config.js → api.js (this file) → ollama.js → lmstudio.js → openai.js → main.js → …

// ── API Abstraction Layer ─────────────────────────────────────
// Routes all network calls through the active flavour.
// Image generation code is intentionally excluded (own toggle, must not change).
//
//  'ollama'   → Ollama native API  (/api/*)           → OllamaAPI
//  'lmstudio' → LM Studio native   (/api/v1/* + /v1/) → LMStudioAPI
//  'openai'   → OpenAI-compatible  (/v1/*)            → OpenAIAPI
const API = {
  isOllama()   { return API_FLAVOR === 'ollama';   },
  isLMStudio() { return API_FLAVOR === 'lmstudio'; },
  isOpenAI()   { return API_FLAVOR === 'openai';   },

  // ── Per-request streaming state ───────────────────────────────
  _lmsCapsCache:     new Map(),  // populated by LMStudioAPI.listModels()
  _lmsReasoningOpts: new Map(),  // key → string[] allowed_options from capabilities.reasoning
  _inThink:          false,      // tracks <think> block across streaming chunks

  resetStream() { API._inThink = false; },

  // Splits raw content into {content, thinking} using <think>…</think> tags.
  // Stateful across chunks — always call resetStream() before a new request.
  _splitThink(raw) {
    if (!raw) return { content: '', thinking: '' };
    let content = '', thinking = '', str = raw;
    while (str) {
      if (!API._inThink) {
        const i = str.indexOf('<think>');
        if (i === -1) { content += str; break; }
        content += str.slice(0, i);
        str = str.slice(i + 7);
        API._inThink = true;
      } else {
        const i = str.indexOf('</think>');
        if (i === -1) { thinking += str; break; }
        thinking += str.slice(0, i);
        str = str.slice(i + 8);
        API._inThink = false;
      }
    }
    return { content, thinking };
  },

  // ── Shared message converter ──────────────────────────────────
  // Converts Ollama-style { images: [b64, …] } attachments into
  // OpenAI multipart content parts (used by LMStudio + OpenAI flavours).
  _convertMessages(messages) {
    return messages.map(msg => {
      if (!msg.images?.length) return msg;
      const parts = [];
      if (msg.content) parts.push({ type: 'text', text: String(msg.content) });
      for (const b64 of msg.images) {
        // Detect MIME type from base64 magic bytes
        let mime = 'image/jpeg';
        if (b64.startsWith('iVBOR'))     mime = 'image/png';
        else if (b64.startsWith('R0lG')) mime = 'image/gif';
        else if (b64.startsWith('UklG')) mime = 'image/webp';
        parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
      }
      const { images: _omit, ...rest } = msg;
      return { ...rest, content: parts };
    });
  },

  // ── Model listing ─────────────────────────────────────────────
  async listModels() {
    if (API.isOllama())   return OllamaAPI.listModels();
    if (API.isLMStudio()) return LMStudioAPI.listModels();
    return OpenAIAPI.listModels();
  },

  // ── Model capabilities ────────────────────────────────────────
  async modelCaps(name) {
    if (API.isOllama()) return OllamaAPI.modelCaps(name);
    // LM Studio: caps populated by listModels(); OpenAI: assume completion only
    if (API._lmsCapsCache.size > 0) return API._lmsCapsCache.get(name) || new Set(['completion']);
    return new Set(['completion']);
  },

  // ── Inference requests ────────────────────────────────────────
  // `tools` — optional OpenAI-format tools[] from ToolsEngine.buildSchemas().
  // Forwarded to Ollama and OpenAI-compat; ignored for LM Studio native path.
  chatRequest(messages, prevResponseId, tools) {
    if (API.isOllama())   return OllamaAPI.chatRequest(messages, tools);
    if (API.isLMStudio()) return LMStudioAPI.chatRequest(messages, prevResponseId);
    return OpenAIAPI.chatRequest(messages, tools);
  },

  correctorRequest(systemPrompt, userPrompt) {
    if (API.isOllama())   return OllamaAPI.correctorRequest(systemPrompt, userPrompt);
    if (API.isLMStudio()) return LMStudioAPI.correctorRequest(systemPrompt, userPrompt);
    return OpenAIAPI.correctorRequest(systemPrompt, userPrompt);
  },

  // ── Streaming chunk parsers ───────────────────────────────────
  parseChatChunk(line) {
    if (API.isOllama())   return OllamaAPI.parseChatChunk(line);
    if (API.isLMStudio()) return LMStudioAPI.parseChatChunk(line);
    return OpenAIAPI.parseChatChunk(line);
  },

  parseCorrectorChunk(line) {
    if (API.isOllama())   return OllamaAPI.parseCorrectorChunk(line);
    if (API.isLMStudio()) return LMStudioAPI.parseCorrectorChunk(line);
    return OpenAIAPI.parseCorrectorChunk(line);
  },

  // Parses the non-streaming JSON body returned by LM Studio's /api/v1/chat.
  // Returns { content, thinking, responseId, stats }.
  parseLmsNativeResponse(data) {
    return LMStudioAPI.parseLmsNativeResponse(data);
  },

  // ── Model management ──────────────────────────────────────────
  async unloadModel(name) {
    if (API.isOllama())   return OllamaAPI.unloadModel(name);
    if (API.isLMStudio()) return LMStudioAPI.unloadModel(name);
    // Generic OpenAI-compat: no standard unload endpoint
  },

  async deleteModel(name) {
    if (!API.isOllama()) throw new Error('Model deletion is not supported by this API');
    return OllamaAPI.deleteModel(name);
  },

  // Running/loaded models
  async runningModels() {
    if (API.isOllama())   return OllamaAPI.runningModels();
    if (API.isLMStudio()) return LMStudioAPI.runningModels();
    return [];
  },

  async serverVersion() {
    if (!API.isOllama()) return {};
    return OllamaAPI.serverVersion();
  },

  // ── Tool-call helpers ─────────────────────────────────────────

  // Merges a tool_calls delta array (OpenAI streaming) into an accumulator
  // object keyed by index.  Call once per chunk that carries delta.tool_calls.
  // acc shape: { [index]: { id, type, function: { name, arguments } } }
  accumulateToolCallDelta(acc, deltas) {
    for (const tc of deltas) {
      const idx = tc.index ?? 0;
      if (!acc[idx]) acc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id)                  acc[idx].id                      = tc.id;
      if (tc.function?.name)      acc[idx].function.name      += tc.function.name;
      if (tc.function?.arguments) acc[idx].function.arguments += tc.function.arguments;
    }
  },

  // Converts the finished accumulator (or Ollama's raw tool_calls array) to a
  // normalised array: [{ id, function: { name, arguments: Object } }]
  normalizeToolCalls(oaiAcc, ollamaArr) {
    if (Object.keys(oaiAcc).length) {
      return Object.values(oaiAcc)
        .filter(tc => tc.function?.name)
        .map(tc => {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          return {
            id:       tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
            function: { name: tc.function.name, arguments: args }
          };
        });
    }
    if (ollamaArr?.length) {
      return ollamaArr.map((tc, i) => ({
        id:       `call_${i}`,
        function: {
          name:      tc.function.name,
          arguments: tc.function.arguments || {}
        }
      }));
    }
    return [];
  },

  // Builds the assistant history message that carries the tool_calls field.
  // Shape differs between Ollama (parsed args object) and OpenAI (string args + id).
  buildAssistantToolMsg(toolCalls) {
    if (API.isOllama()) {
      return {
        role:       'assistant',
        content:    '',
        tool_calls: toolCalls.map(tc => ({
          function: { name: tc.function.name, arguments: tc.function.arguments }
        }))
      };
    }
    // OpenAI-compat (including LM Studio OpenAI path)
    return {
      role:       'assistant',
      content:    null,
      tool_calls: toolCalls.map(tc => ({
        id:       tc.id,
        type:     'function',
        function: {
          name:      tc.function.name,
          arguments: JSON.stringify(tc.function.arguments)
        }
      }))
    };
  },

  // Builds a tool-result history message for one executed tool call.
  buildToolResultMsg(toolCall, resultStr) {
    if (API.isOllama()) {
      return { role: 'tool', content: resultStr };
    }
    return { role: 'tool', tool_call_id: toolCall.id, content: resultStr };
  },

  // Connection-check endpoint for each flavour
  checkUrl(base, flavor) {
    const b = (base || OLLAMA_BASE).replace(/\/$/, '');
    const f = flavor || API_FLAVOR;
    if (f === 'ollama')   return OllamaAPI.checkUrl(b);
    if (f === 'lmstudio') return LMStudioAPI.checkUrl(b);
    return OpenAIAPI.checkUrl(b);
  }
};
