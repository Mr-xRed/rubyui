// ══ CONFIG.JS ════════════════════════════════════════════════
// All persisted settings (localStorage reads) and app-wide constants.
// No DOM access. No functions. No side-effects.
//
// Load order in index.html:
//   config.js  (this file — FIRST)
//   api.js → ollama.js → lmstudio.js → openai.js
//   main.js → search.js → settings.js
//   corrector.js → chat.js → image.js → backend.js → status-panel.js

// --- API Connection ---
let OLLAMA_BASE  = localStorage.getItem('ollama_base')   || 'http://localhost:11434';
let API_FLAVOR   = localStorage.getItem('api_flavor')    || 'ollama';
let BACKEND_CLIENT_ID_OVERRIDE = localStorage.getItem('backend_client_id_override') || '';

let ADV_OPTIONS = JSON.parse(localStorage.getItem('ollama_options')) || {
  temperature:    null,
  num_ctx:        null,
  top_p:          null,
  repeat_penalty: null,
  num_batch:      null
};

const DEFAULT_CORRECTOR_SYSTEM =
  `You are a professional proofreader. Correct the grammar, spelling, punctuation, and style of the following text. Return ONLY the corrected text — no explanations, no commentary, no quotes, no preamble, no markdown.`;

const _DEFAULT_PROMPT_ID = 'default';
const _DEFAULT_CHAT_PROMPTS = [
  { id: _DEFAULT_PROMPT_ID, name: 'Default', content: '' }
];

let CORRECTOR_SYSTEM = localStorage.getItem('corrector_system') ?? DEFAULT_CORRECTOR_SYSTEM;

let CHAT_PROMPTS = (function() {
  try {
    const stored = JSON.parse(localStorage.getItem('chat_prompts'));
    if (Array.isArray(stored) && stored.length) return stored;
  } catch (_) {}
  const legacy = localStorage.getItem('chat_system');
  if (legacy !== null) {
    return [
      { id: _DEFAULT_PROMPT_ID, name: 'Default', content: legacy },
    ];
  }
  return _DEFAULT_CHAT_PROMPTS.map(p => ({ ...p }));
})();

let ACTIVE_PROMPT_ID = localStorage.getItem('active_prompt_id') ?? _DEFAULT_PROMPT_ID;
if (!CHAT_PROMPTS.find(p => p.id === ACTIVE_PROMPT_ID)) {
  ACTIVE_PROMPT_ID = CHAT_PROMPTS[0]?.id ?? '';
}

function interpolatePrompt(text) {
  if (!text || !text.includes('{{')) return text;
  const now = new Date();
  return text
    .replace(/\{\{date\}\}/g,     now.toLocaleDateString())
    .replace(/\{\{date_iso\}\}/g, now.toISOString().slice(0, 10))
    .replace(/\{\{time\}\}/g,     now.toLocaleTimeString())
    .replace(/\{\{time_24\}\}/g,  now.toTimeString().slice(0, 5))
    .replace(/\{\{datetime\}\}/g, now.toLocaleString())
    .replace(/\{\{weekday\}\}/g,  now.toLocaleDateString(undefined, { weekday: 'long' }))
    .replace(/\{\{timezone\}\}/g, Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function getActiveChatSystem() {
  const raw = CHAT_PROMPTS.find(p => p.id === ACTIVE_PROMPT_ID)?.content ?? '';
  return interpolatePrompt(raw);
}

let BRAVE_API_KEY   = localStorage.getItem('brave_api_key')   || '';
let BRAVE_RESULTS   = parseInt(localStorage.getItem('brave_results'))  || 5;
let BRAVE_PROXY_URL = localStorage.getItem('brave_proxy_url') || '';

const DEFAULT_ACCENT     = '#e8c97a';
const DEFAULT_CHAT_WIDTH = 900;
let APP_THEME     = localStorage.getItem('app_theme')       || 'dark';
let APP_FONT_SIZE = parseInt(localStorage.getItem('app_font_size')) || 18;
let APP_ACCENT    = localStorage.getItem('app_accent')      || DEFAULT_ACCENT;
let SHOW_STATS    = localStorage.getItem('show_stats') !== 'false';
let CHAT_WIDTH    = parseInt(localStorage.getItem('chat_width')) || DEFAULT_CHAT_WIDTH;

let IMG_API_MODE = localStorage.getItem('img_api_mode') || 'native';
let IMG_API_BASE = localStorage.getItem('img_api_base') || '';
let IMG_API_FLAVOR = localStorage.getItem('img_api_flavor') || (IMG_API_MODE === 'native' ? 'ollama' : 'openai');

let CF_ACCESS_TEAM = localStorage.getItem('cf_access_team') || 'rubyrinth';

let TOOLS_ENABLED = localStorage.getItem('tools_enabled') !== 'false';

let MAX_TOOL_ROUNDS = parseInt(localStorage.getItem('max_tool_rounds'));
if (!Number.isFinite(MAX_TOOL_ROUNDS) || MAX_TOOL_ROUNDS < 0) MAX_TOOL_ROUNDS = 5;

let BUILTIN_TOOLS = JSON.parse(localStorage.getItem('builtin_tools') || '{}');
if (BUILTIN_TOOLS.get_current_datetime === undefined) BUILTIN_TOOLS.get_current_datetime = true;

const DEFAULT_IMG_TOOL_DESCRIPTION =
  'Generate an image from a text prompt and show it to the user inline in the chat. ' +
  'width and height must each be an exact multiple of 16, and neither may exceed 1920. ' +
  'Default to {{img_tool_default_width}}x{{img_tool_default_height}} unless the user asks for a different size or aspect ratio.';
let IMG_TOOL_DESCRIPTION    = localStorage.getItem('img_tool_description') ?? DEFAULT_IMG_TOOL_DESCRIPTION;
let IMG_TOOL_DEFAULT_WIDTH  = parseInt(localStorage.getItem('img_tool_default_width'))  || 512;
let IMG_TOOL_DEFAULT_HEIGHT = parseInt(localStorage.getItem('img_tool_default_height')) || 512;

function getImgToolDescription() {
  return (IMG_TOOL_DESCRIPTION || DEFAULT_IMG_TOOL_DESCRIPTION)
    .replace(/\{\{img_tool_default_width\}\}/g,  String(IMG_TOOL_DEFAULT_WIDTH))
    .replace(/\{\{img_tool_default_height\}\}/g, String(IMG_TOOL_DEFAULT_HEIGHT));
}

// ── RAG / Qdrant ─────────────────────────────────────────────
let RAG_QDRANT_URL   = localStorage.getItem('rag_qdrant_url')   || 'http://qdrant:6333';
let RAG_EMBED_MODEL  = localStorage.getItem('rag_embed_model')  || 'bge-m3';
let RAG_EMBED_FLAVOR = localStorage.getItem('rag_embed_flavor') || 'ollama';
let RAG_ACTIVE_COLLECTION = localStorage.getItem('rag_active_collection') || '';
let RAG_TOP_K = parseInt(localStorage.getItem('rag_top_k')) || 5;

const DEFAULT_RAG_TOOL_DESCRIPTION =
  'Search the "{{rag_collection}}" knowledge base for information relevant to a specific question or topic. ' +
  'Use this whenever answering well requires grounded facts, citations, or details that may exist in this knowledge base. ' +
  'If the user\'s request touches several distinct topics, call this tool once PER topic with a focused, single-topic query ' +
  'rather than combining unrelated topics into one query string — issue separate sequential calls instead. ' +
  'You can set top_k to control how many results come back, from 1 to 20 (default 5 if omitted) — use a higher value for ' +
  'broad or open-ended topics where more context helps, and a lower value for narrow, specific lookups. ' +
  'You may call this tool multiple times in the same turn before giving your final answer.';
let RAG_TOOL_DESCRIPTION = localStorage.getItem('rag_tool_description') ?? DEFAULT_RAG_TOOL_DESCRIPTION;

let RAG_FIELD_FILTER_MODE = localStorage.getItem('rag_field_filter_mode') || 'all';
let RAG_FIELD_WHITELIST   = JSON.parse(localStorage.getItem('rag_field_whitelist') || '[]');
let RAG_FIELD_BLACKLIST   = JSON.parse(localStorage.getItem('rag_field_blacklist') || '[]');

let TOOLS_CONFIG = JSON.parse(localStorage.getItem('tools_config') || '[]');

// ── Long-Term Memory ───────────────────────────────────────────
// One global memory store for the whole user (not per-chat, not per-RAG-
// collection) — a single Qdrant collection ("jarvis_memory", fixed
// server-side) backed by human-readable markdown files on the server.
// Reuses the RAG embedding pipeline (RAG_QDRANT_URL / RAG_EMBED_MODEL /
// RAG_EMBED_FLAVOR above) rather than introducing a second one, since it's
// the same Qdrant instance in the overwhelming majority of setups.
//
// Master switch — when false, no memory is retrieved OR saved:
// injectMemoryContext() (memory.js) becomes a no-op and the save_memory /
// search_memory built-ins are hidden from buildSchemas() regardless of
// their individual BUILTIN_TOOLS toggle.
let MEMORY_ENABLED = localStorage.getItem('memory_enabled') !== 'false';
// How many top-K memories to retrieve and inject per turn.
let MEMORY_TOP_K = parseInt(localStorage.getItem('memory_top_k')) || 5;
// Minimum cosine similarity score (0–1) a memory must clear to be injected
// or returned by search_memory. Filters out low-relevance noise so memory
// isn't dragged into every single turn regardless of topic. 0 = no filter.
// 0.55 is a reasonable starting point for nomic-embed-text-style cosine
// similarity — clearly-relevant matches on this class of model typically
// score ~0.5–0.8, unrelated text usually sits below ~0.4. Adjustable in
// Settings → Memory since the right value depends on the embedding model.
let MEMORY_MIN_SCORE = parseFloat(localStorage.getItem('memory_min_score'));
if (!Number.isFinite(MEMORY_MIN_SCORE) || MEMORY_MIN_SCORE < 0 || MEMORY_MIN_SCORE > 1) MEMORY_MIN_SCORE = 0.55;

// Description sent to the model for the save_memory built-in tool. Editable
// later via Settings → Tool Calling → Built-in Tools, same mechanism as
// IMG_TOOL_DESCRIPTION above (see getMemoryToolDescription() in memory.js).
const DEFAULT_MEMORY_SAVE_TOOL_DESCRIPTION =
  'Save something to long-term memory. This is not optional or occasional — call it EVERY TIME the user ' +
  'shares ANYTHING that could plausibly matter in a future, unrelated conversation. Do this silently, ' +
  'without asking permission and without announcing it, in the same turn the information appears. ' +
  'Default to saving when in doubt — a missed memory is a worse outcome than an over-cautious one. ' +
  'Save things like: preferences and opinions of any kind ("I like...", "I use...", "I hate...", "always...", ' +
  '"never..."), facts about the user, their people, their work, their projects, their tools, their setup, ' +
  'or their environment; goals, plans, or ongoing situations; decisions they\'ve made; names, dates, ' +
  'relationships; and corrections to anything you previously assumed. ' +
  'Do NOT save things that are purely about this single exchange and have no plausible future relevance ' +
  '(e.g. "format this as a table", "what does line 12 do") — but when in real doubt, save it anyway. ' +
  'You may call this multiple times in one turn if the user shared several distinct memorable things. ' +
  'Keep each memory short, self-contained, and written so it makes sense on its own when retrieved later ' +
  'out of context — one clear fact per call, third person, no pronouns without antecedents. ' +
  'If you\'re inferring rather than being told directly, still save it, just set confidence to "inferred". ' +
  'IMPORTANT: if the user is correcting, updating, or replacing something you already know — especially ' +
  'anything shown to you under "## Long-term memory" earlier in this conversation — do NOT call this tool. ' +
  'Call update_memory instead so the old entry is edited in place rather than duplicated.';
let MEMORY_SAVE_TOOL_DESCRIPTION = localStorage.getItem('memory_save_tool_description') ?? DEFAULT_MEMORY_SAVE_TOOL_DESCRIPTION;

const DEFAULT_MEMORY_SEARCH_TOOL_DESCRIPTION =
  'Search long-term memory for previously saved facts, preferences, or context that might be relevant ' +
  'right now. Relevant memories are already retrieved and injected automatically for every message, so ' +
  'only call this if you need a different, narrower, or more specific query than the user\'s latest message ' +
  '— for example, to check whether something contradicts an earlier stated preference. ' +
  'Also use this FIRST whenever you are about to call update_memory: you need the exact id of the entry ' +
  'you intend to edit, and this is the only way to get it — never guess or reuse an id from memory.';
let MEMORY_SEARCH_TOOL_DESCRIPTION = localStorage.getItem('memory_search_tool_description') ?? DEFAULT_MEMORY_SEARCH_TOOL_DESCRIPTION;

const DEFAULT_MEMORY_UPDATE_TOOL_DESCRIPTION =
  'Edit an existing long-term memory in place, instead of creating a new (duplicate) one. Use this whenever ' +
  'the user corrects, updates, refines, or contradicts something already saved to memory — for example they ' +
  'previously said they use Python and now say they\'ve switched to TypeScript. ' +
  'You MUST call search_memory first to find the exact "id" of the entry to edit — never guess an id, and ' +
  'never call this with an id you have not just seen in a search_memory result. If no existing memory ' +
  'actually matches what the user is telling you, use save_memory to create a new one instead of forcing an ' +
  'update onto an unrelated entry. Only include the fields you want to change; anything omitted is left as-is.';
let MEMORY_UPDATE_TOOL_DESCRIPTION = localStorage.getItem('memory_update_tool_description') ?? DEFAULT_MEMORY_UPDATE_TOOL_DESCRIPTION;

if (BUILTIN_TOOLS.save_memory   === undefined) BUILTIN_TOOLS.save_memory   = true;
if (BUILTIN_TOOLS.search_memory === undefined) BUILTIN_TOOLS.search_memory = true;
if (BUILTIN_TOOLS.update_memory === undefined) BUILTIN_TOOLS.update_memory = true;
