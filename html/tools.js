// ══ TOOLS.JS ════════════════════════════════════════════════
// Tool-calling engine — HTTP tools and MCP servers (streamable
// HTTP / JSON-RPC transport, browser-compatible).
//
// Exposes the global `ToolsEngine` used by chat.js.
//
// Depends on: config.js  (TOOLS_ENABLED, TOOLS_CONFIG)
//
// Load order in index.html:
//   config.js → api.js → ollama.js → lmstudio.js → openai.js
//   → main.js → search.js → settings.js → corrector.js
//   → tools.js (THIS FILE)  ← insert here
//   → chat.js → image.js → backend.js → status-panel.js

const ToolsEngine = {

  // ── Built-in tools catalogue ──────────────────────────────────
  // Hardcoded tools resolved entirely client-side (no HTTP, no MCP).
  // Each entry: { name, description, parameters, execute() }
  // Toggled individually via BUILTIN_TOOLS[name] in config.js.
  BUILTIN_CATALOGUE: [
    {
      name:        'get_current_datetime',
      displayName: 'Returns the current date-time',
      description: 'Returns the current date, time, weekday, and timezone as understood by the user\'s browser. Call this whenever the user asks about the current time, date, day of the week, or timezone.',
      parameters:  { type: 'object', properties: {} },
      execute()  {
        const now = new Date();
        return JSON.stringify({
          iso:      now.toISOString(),
          date:     now.toLocaleDateString(),
          time:     now.toLocaleTimeString(),
          time_24:  now.toTimeString().slice(0, 5),
          weekday:  now.toLocaleDateString(undefined, { weekday: 'long' }),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        });
      }
    },
    {
      name:        'generate_image',
      displayName: 'Generates an image',
      description: 'Generate an image from a text prompt and show it to the user inline in the chat. width and height must each be an exact multiple of 16, and neither may exceed 1920.',
      // Settings → Tool Calling → Built-in Tools lets the user edit the
      // description and default size shown here — see getImgToolDescription()
      // in config.js. Falls back to the static `description` above if
      // config.js somehow isn't loaded.
      descriptionFn: () => (typeof getImgToolDescription === 'function' ? getImgToolDescription() : undefined),
      parameters:  {
        type: 'object',
        properties: {
          prompt: { type: 'string',  description: 'Description of the image to generate.' },
          width:  { type: 'integer', description: 'Image width in pixels — must be a multiple of 16, max 1920. Omit to use the configured default.' },
          height: { type: 'integer', description: 'Image height in pixels — must be a multiple of 16, max 1920. Omit to use the configured default.' }
        },
        required: ['prompt']
      },
      // Reuses the app's own generation pipeline (image.js / backend.js) —
      // whichever path is already active (server job queue when
      // BACKEND_AVAILABLE, otherwise direct Ollama/OpenAI-compat) — instead
      // of a hand-rolled call to an external endpoint. See generateImageForTool()
      // in image.js. Returns a `[[JARVIS_IMAGE:id]]` marker that chat.js's
      // tool-call loop recognises, strips out of the model-facing message,
      // and turns into a <jarvis_img id="..."> tag rendered inline in the bubble.
      async execute({ prompt, width, height }) {
        const defW = (typeof IMG_TOOL_DEFAULT_WIDTH  !== 'undefined' && IMG_TOOL_DEFAULT_WIDTH)  || 512;
        const defH = (typeof IMG_TOOL_DEFAULT_HEIGHT !== 'undefined' && IMG_TOOL_DEFAULT_HEIGHT) || 512;
        width  = (width  === undefined || width  === null || width  === '') ? defW : Math.round(Number(width));
        height = (height === undefined || height === null || height === '') ? defH : Math.round(Number(height));
        if (!prompt || !prompt.trim())
          throw new Error('prompt must not be empty.');
        if (!Number.isFinite(width) || !Number.isFinite(height) || width % 16 !== 0 || height % 16 !== 0)
          throw new Error('width and height must both be exact multiples of 16.');
        if (width > 1920 || height > 1920)
          throw new Error('width and height must not exceed 1920.');
        if (width < 64 || height < 64)
          throw new Error('width and height must be at least 64.');
        if (typeof generateImageForTool !== 'function')
          throw new Error('Image generation is unavailable (image.js did not load).');

        const img = await generateImageForTool(prompt, width, height);
        const id  = 'ti_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        if (typeof _registerToolImage === 'function') _registerToolImage(id, img);
        return `[[JARVIS_IMAGE:${id}]] Image generated successfully and displayed to the user in the chat.`;
      }
    },
    {
      name:        'save_memory',
      displayName: 'Saves a long-term memory',
      description: 'Save a durable fact, preference, or piece of context to long-term memory so it can be recalled in future conversations.',
      // Settings → Tool Calling → Built-in Tools lets the user edit this —
      // see MEMORY_SAVE_TOOL_DESCRIPTION in config.js. Falls back to the
      // static description above if config.js somehow isn't loaded.
      descriptionFn: () => (typeof MEMORY_SAVE_TOOL_DESCRIPTION === 'string' && MEMORY_SAVE_TOOL_DESCRIPTION) || undefined,
      parameters: {
        type: 'object',
        properties: {
          text:       { type: 'string', description: 'The fact/preference/context to remember. Short, self-contained, makes sense out of context.' },
          tags:       { type: 'array', items: { type: 'string' }, description: 'Optional short tags for later filtering, e.g. ["preference", "project-x"].' },
          confidence: { type: 'string', enum: ['stated', 'inferred'], description: '"stated" if the user said this directly, "inferred" if you deduced it. Defaults to "stated".' }
        },
        required: ['text']
      },
      // Delegates to memory.js's executeSaveMemoryTool(), same pattern as
      // rag_search delegating to rag.js's executeRagSearchTool() below.
      // That function branches internally: goes through /api/memory/save
      // (writes markdown + Qdrant) when BACKEND_AVAILABLE, or writes
      // directly into Qdrant only when running local/no-backend — see the
      // comment above executeSaveMemoryTool() in memory.js for what that
      // fallback does and doesn't preserve.
      async execute({ text, tags, confidence }) {
        if (typeof window.executeSaveMemoryTool !== 'function')
          throw new Error('Memory is unavailable (memory.js did not load).');
        return window.executeSaveMemoryTool({ text, tags, confidence });
      }
    },
    {
      name:        'search_memory',
      displayName: 'Searches long-term memory',
      description: 'Search long-term memory for previously saved facts or preferences relevant to a specific query.',
      descriptionFn: () => (typeof MEMORY_SEARCH_TOOL_DESCRIPTION === 'string' && MEMORY_SEARCH_TOOL_DESCRIPTION) || undefined,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A focused search query.' },
          top_k: { type: 'integer', minimum: 1, maximum: 20, description: 'Number of memories to retrieve, 1-20. Defaults to 5.' }
        },
        required: ['query']
      },
      // Delegates to memory.js's executeSearchMemoryTool() — searches
      // Qdrant directly in local/no-backend mode, via /api/memory/search
      // otherwise. See save_memory above for the same pattern.
      async execute({ query, top_k }) {
        if (typeof window.executeSearchMemoryTool !== 'function')
          throw new Error('Memory is unavailable (memory.js did not load).');
        return window.executeSearchMemoryTool({ query, top_k });
      }
    },
    {
      name:        'update_memory',
      displayName: 'Updates a long-term memory',
      description: 'Edit an existing long-term memory in place instead of creating a duplicate. Requires the exact id from a prior search_memory call.',
      descriptionFn: () => (typeof MEMORY_UPDATE_TOOL_DESCRIPTION === 'string' && MEMORY_UPDATE_TOOL_DESCRIPTION) || undefined,
      parameters: {
        type: 'object',
        properties: {
          id:         { type: 'string', description: 'The exact id of the memory to edit — must come from a search_memory result, never guessed.' },
          text:       { type: 'string', description: 'New text for the memory. Omit to leave unchanged.' },
          tags:       { type: 'array', items: { type: 'string' }, description: 'New tags, replacing the old ones. Omit to leave unchanged.' },
          confidence: { type: 'string', enum: ['stated', 'inferred'], description: 'Omit to leave unchanged.' }
        },
        required: ['id']
      },
      // Delegates to memory.js's executeUpdateMemoryTool() — edits the
      // Qdrant point in place in local/no-backend mode (no markdown to
      // update), via /api/memory/{id} PUT otherwise. See save_memory above
      // for the same pattern.
      async execute({ id, text, tags, confidence }) {
        if (typeof window.executeUpdateMemoryTool !== 'function')
          throw new Error('Memory is unavailable (memory.js did not load).');
        return window.executeUpdateMemoryTool({ id, text, tags, confidence });
      }
    }
    // ── Add future built-ins here, same shape ─────────────────
    // { name: 'get_user_locale', displayName: 'Short UI label (optional)', description: '...', parameters: {...}, execute() { ... } }
  ],

  // ── Schema builder ────────────────────────────────────────────
  // Returns an OpenAI-format tools[] array built from all enabled
  // entries in TOOLS_CONFIG.  Safe to call even when TOOLS_CONFIG
  // is empty — returns [].
  buildSchemas() {
    if (!TOOLS_ENABLED) return [];
    const schemas = [];

    // ── Built-in tools (client-side, no config entry needed) ──
    for (const bt of ToolsEngine.BUILTIN_CATALOGUE) {
      if (BUILTIN_TOOLS[bt.name] === false) continue;  // respect per-tool toggle
      // Master memory switch (Settings → Memory, config.js) overrides the
      // per-tool toggle above for the two memory built-ins.
      if ((bt.name === 'save_memory' || bt.name === 'search_memory' || bt.name === 'update_memory') &&
          typeof MEMORY_ENABLED !== 'undefined' && !MEMORY_ENABLED) continue;
      // descriptionFn lets a built-in's description be user-configurable
      // (Settings → Tool Calling → Built-in Tools) without needing a config
      // entry — see generate_image below. Falls back to the static string.
      const description = typeof bt.descriptionFn === 'function' ? bt.descriptionFn() : bt.description;
      schemas.push({
        type: 'function',
        function: { name: bt.name, description, parameters: bt.parameters }
      });
    }

    for (const entry of TOOLS_CONFIG) {
      if (!entry.enabled) continue;

      if (entry.type === 'http') {
        schemas.push({
          type: 'function',
          function: {
            name:        entry.name,
            description: entry.description || '',
            parameters:  entry.parameters  || { type: 'object', properties: {} }
          }
        });

      } else if (entry.type === 'mcp') {
        // Each MCP server exposes N tools; namespace with server id to
        // avoid collisions across servers.
        for (const mt of (entry.discoveredTools || [])) {
          if (mt.enabled === false) continue;
          schemas.push({
            type: 'function',
            function: {
              name:        `mcp__${entry.id}__${mt.name}`,
              description: mt.description || '',
              parameters:  mt.inputSchema || { type: 'object', properties: {} }
            }
          });
        }
      }
    }

    // ── RAG-as-a-tool (rag.js) ────────────────────────────────
    // Only present when the Chat-mode RAG selector is set to "Tool" and a
    // collection is selected. Defined dynamically (not in TOOLS_CONFIG)
    // because it depends on live UI state, not saved tool config.
    if (typeof window.getRagToolSchema === 'function') {
      const ragSchema = window.getRagToolSchema();
      if (ragSchema) schemas.push(ragSchema);
    }

    return schemas;
  },

  // ── Tool dispatcher ───────────────────────────────────────────
  // Resolves name → HTTP tool or MCP tool and executes it.
  // Returns a plain string suitable for the tool-result message.
  async executeToolCall(name, argsObj) {
    // ── RAG-as-a-tool — resolved client-side via rag.js ───────
    if (name === 'rag_search') {
      if (typeof window.executeRagSearchTool !== 'function')
        throw new Error('RAG search tool is unavailable (rag.js not loaded)');
      return window.executeRagSearchTool(argsObj);
    }

    // ── Built-in tool — resolved entirely client-side ─────────
    const builtin = ToolsEngine.BUILTIN_CATALOGUE.find(bt => bt.name === name);
    if (builtin) {
      if (BUILTIN_TOOLS[name] === false)
        throw new Error(`Built-in tool is disabled: ${name}`);
      if ((name === 'save_memory' || name === 'search_memory' || name === 'update_memory') &&
          typeof MEMORY_ENABLED !== 'undefined' && !MEMORY_ENABLED)
        throw new Error('Long-term memory is disabled.');
      return builtin.execute(argsObj);
    }

    // MCP namespaced call: "mcp__{serverId}__{toolName}"
    if (name.startsWith('mcp__')) {
      const parts    = name.split('__');
      const serverId = parts[1];
      const toolName = parts.slice(2).join('__');
      const server   = TOOLS_CONFIG.find(
        t => t.type === 'mcp' && t.id === serverId && t.enabled !== false
      );
      if (!server) throw new Error(`MCP server not found or disabled: ${serverId}`);
      return ToolsEngine._callMcp(server, toolName, argsObj);
    }

    // HTTP tool — match by function name
    const tool = TOOLS_CONFIG.find(
      t => t.type === 'http' && t.name === name && t.enabled !== false
    );
    if (tool) return ToolsEngine._callHttp(tool, argsObj);

    throw new Error(`Unknown tool: ${name}`);
  },

  // ── HTTP tool executor ────────────────────────────────────────
  // Supports {{param}} substitution in both URL and body template.
  // If bodyTemplate is empty, the args object is JSON-serialised as body.
  async _callHttp(tool, args) {
    const method  = (tool.method || 'GET').toUpperCase();
    let   url     = tool.url;
    const headers = Object.assign({}, tool.headers || {});

    // Substitute placeholders in URL path/query
    for (const [k, v] of Object.entries(args)) {
      url = url.split(`{{${k}}}`).join(encodeURIComponent(String(v)));
    }

    const opts = { method, headers };

    if (method !== 'GET' && method !== 'HEAD') {
      let bodyStr = (tool.bodyTemplate || '').trim();
      if (bodyStr) {
        for (const [k, v] of Object.entries(args)) {
          bodyStr = bodyStr.split(`{{${k}}}`).join(String(v));
        }
      } else {
        bodyStr = JSON.stringify(args);
      }
      if (!headers['Content-Type'] && !headers['content-type'])
        headers['Content-Type'] = 'application/json';
      opts.body = bodyStr;
    }

    const res  = await fetch(url, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);

    // Apply field filter if configured on this tool
    return tool.responseFilter
      ? ToolsEngine._applyResponseFilter(text, tool.responseFilter)
      : text;
  },

  // ── Response field filter ─────────────────────────────────────
  // Parses the JSON response and keeps/drops fields within the array
  // found at `filter.path` (dot-notation, e.g. "web.results").
  // If path is empty the root value is filtered directly.
  //
  // filter shape: { path: string, pick: string, drop: string }
  //   pick — comma-separated whitelist of fields to keep (applied per item)
  //   drop — comma-separated blacklist of fields to remove (ignored when pick set)
  //
  // Returns a JSON string of the filtered result (or the original text on parse failure).
  // ── Response field filter ─────────────────────────────────────
  _applyResponseFilter(text, filter) {
    const pickFields = (filter.pick || '').split(',').map(s => s.trim()).filter(Boolean);
    const dropFields = (filter.drop || '').split(',').map(s => s.trim()).filter(Boolean);
    const hasPath    = !!(filter.path || '').trim();
    const hasLimit   = (parseInt(filter.limit) || 0) > 0;
    if (!pickFields.length && !dropFields.length && !hasPath && !hasLimit) return text;
    let data;
    try { data = JSON.parse(text); } catch { return text; }

    // Navigate to the target using a regex split that respects backslash escaping
    let target = data;
    if (filter.path) {
      // Splits by dots, unless they are preceded by a backslash
      const keys = filter.path.split(/(?<!\\)\./).map(k => k.replace(/\\./g, '.'));
      
      for (const key of keys) {
        if (target == null || typeof target !== 'object') return text;
        target = target[key];
      }
    }

    function filterObj(obj) {
      if (typeof obj !== 'object' || obj === null) return obj;
      const out = {};
      if (pickFields.length) {
        for (const f of pickFields) if (f in obj) out[f] = obj[f];
      } else {
        for (const k of Object.keys(obj)) if (!dropFields.includes(k)) out[k] = obj[k];
      }
      return out;
    }

    let filtered = Array.isArray(target)
      ? target.map(filterObj)
      : filterObj(target);

    // Apply result-count cap (limit: 0 means no limit)
    const limit = parseInt(filter.limit) || 0;
    if (limit > 0 && Array.isArray(filtered)) {
      filtered = filtered.slice(0, limit);
    }

    return JSON.stringify(filtered, null, 2);
  },

  // ── MCP tool executor (streamable HTTP transport) ─────────────
  // POSTs a JSON-RPC tools/call request.  Handles both plain-JSON
  // and SSE-wrapped responses from the server.
  async _callMcp(server, toolName, args) {
    const res = await fetch(server.url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id:      Date.now(),
        method:  'tools/call',
        params:  { name: toolName, arguments: args }
      }),
      signal: AbortSignal.timeout(30000)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    return ToolsEngine._parseMcpText(text);
  },

  // Extracts the result string from a JSON-RPC response body.
  // Handles plain JSON and SSE-wrapped JSON (data: {...} lines).
  _parseMcpText(text) {
    // ── Plain JSON ────────────────────────────────────────────
    try {
      const json = JSON.parse(text);
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      return ToolsEngine._extractMcpResult(json.result);
    } catch (e) {
      if (!text.includes('data:')) throw e;
    }

    // ── SSE wrapping — scan data: lines in reverse for result ─
    const lines = text.split('\n').filter(l => l.startsWith('data:'));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const json = JSON.parse(lines[i].slice(5).trim());
        if (json.result !== undefined)
          return ToolsEngine._extractMcpResult(json.result);
        if (json.error)
          throw new Error(json.error.message || JSON.stringify(json.error));
      } catch {}
    }
    throw new Error('Could not parse MCP response');
  },

  _extractMcpResult(result) {
    if (Array.isArray(result?.content))
      return result.content.map(c => c.text ?? JSON.stringify(c)).join('\n');
    if (typeof result === 'string') return result;
    return JSON.stringify(result ?? '');
  },

  // ── MCP tool discovery ────────────────────────────────────────
  // Runs: initialize → tools/list.
  // Returns an array of { name, description, inputSchema, enabled }
  // suitable for storing in entry.discoveredTools.
  async discoverMcpTools(serverUrl) {
    // initialize is best-effort; many servers don't strictly require it
    await fetch(serverUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body:    JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params:  {
          protocolVersion: '2024-11-05',
          capabilities:    {},
          clientInfo:      { name: 'jarvis', version: '1.0' }
        }
      }),
      signal: AbortSignal.timeout(5000)
    }).catch(() => {});

    const res = await fetch(serverUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      signal:  AbortSignal.timeout(10000)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);

    let json;
    try { json = JSON.parse(text); }
    catch {
      const lines = text.split('\n').filter(l => l.startsWith('data:'));
      for (let i = lines.length - 1; i >= 0; i--) {
        try { json = JSON.parse(lines[i].slice(5).trim()); break; } catch {}
      }
    }
    if (!json)      throw new Error('Could not parse MCP server response');
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));

    return (json.result?.tools || []).map(t => ({
      name:        t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      enabled:     true
    }));
  }
};
