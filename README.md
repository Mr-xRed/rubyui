# AmarinthUI — Local LLM UI

A single-page, no-build-step frontend for local LLM inference. Talks directly to **Ollama**, **LM Studio**, or any **OpenAI-compatible** endpoint, with optional RAG (Qdrant) and long-term memory.

It can be run two ways:

| | **Local mode** | **Server mode** |
|---|---|---|
| What it is | Open `html/index.html` as a static file/folder — no backend | Full stack via Docker Compose: nginx + FastAPI backend + Qdrant |
| Setup effort | Zero — just serve the HTML | `docker compose up` |
| Best for | Quick use, single device, trying it out | Multi-device access, long-running jobs, full RAG/memory |

Both modes share the exact same UI and the exact same `html/` codebase — the frontend detects whether a backend is reachable and switches behavior automatically. You don't choose a mode; the app does, per session.

---

## Table of contents

- [How mode detection works](#how-mode-detection-works)
- [Feature comparison](#feature-comparison)
- [Core modes](#core-modes)
- [Why lib/ is vendored, not CDN-loaded](#why-lib-is-vendored-not-cdn-loaded)
- [Local mode: setup & usage](#local-mode-setup--usage)
- [Server mode: setup & usage](#server-mode-setup--usage)
- [Configuration reference](#configuration-reference)
- [Known limitations of local mode](#known-limitations-of-local-mode)
- [Folder structure](#folder-structure)

---
## Screeenshots
- Chat
![AmarinthUI Chat](https://raw.githubusercontent.com/Mr-xRed/amarinthui/refs/heads/main/screenshots/amarinthui_chat.png)

- Image Generation
![AmarinthUI Image Generation](https://raw.githubusercontent.com/Mr-xRed/amarinthui/refs/heads/main/screenshots/amarinthui_image_gen.png)

- Model Manager
![AmarinthUI Model Manager](https://raw.githubusercontent.com/Mr-xRed/amarinthui/refs/heads/main/screenshots/amarinthui_model_manager.png)

---

## How mode detection works

On page load, the frontend pings `/api/health`. If it gets a response, **server mode** is active for that session (`BACKEND_AVAILABLE = true`); if it times out, gets no response, or the page was opened directly via `file://`, the app silently falls back to **local mode** — no configuration needed, no error shown.

This means the *same* `html/` folder works standalone (double-click `index.html`, or serve it from any static file host / CDN / `python -m http.server`) or in front of the full backend — whichever is reachable wins.

---

## Feature comparison

| Feature | Local mode | Server mode |
|---|:---:|:---:|
| **Chat** — multi-turn, streaming, history | ✅ | ✅ |
| **Chat** — file/image/audio attachments | ✅ | ✅ |
| **Chat** — tool calling (HTTP tools, MCP servers, built-ins) | ✅ | ✅ |
| **Chat** — survives closing the browser tab mid-reply | ❌ | ✅ (server job keeps running, reconnects on reopen) |
| **Corrector** — proofreading + word-diff | ✅ | ✅ |
| **Image generation** — Ollama-native or OpenAI-compatible | ✅ | ✅ |
| **Image generation** — survives closing the tab mid-generation | ❌ | ✅ |
| **RAG** — search an existing Qdrant collection | ✅ | ✅ |
| **RAG** — list collections / connection status | ✅ | ✅ |
| **RAG** — create/delete collections | ❌ | ✅ |
| **RAG** — ingest files (PDF, CSV, XLSX, JSON, Markdown, chapter/chunk-aware splitting) | ❌ | ✅ |
| **RAG** — inspect collection fields (whitelist/blacklist picker) | ❌ | ✅ |
| **Memory** — recall (`search_memory`, auto-injection) | ✅ | ✅ |
| **Memory** — save / update (`save_memory`, `update_memory`) | ✅ (Qdrant-only, see below) | ✅ |
| **Memory** — human-readable markdown source of truth | ❌ | ✅ |
| **Memory** — browse/edit/delete in Settings panel | ❌ | ✅ |
| **Memory** — reindex Qdrant from markdown | ❌ | ✅ |
| **Embedding model listing / dimension probing** | ✅ (queries Ollama/OpenAI directly) | ✅ |

**In short:** local mode covers everyday chat, image gen, RAG search, and memory recall+save with zero setup. Server mode adds durability (jobs survive tab closes), RAG ingestion, and full memory management (browse/edit/reindex from markdown).

### A note on local-mode memory

When no backend is reachable, `save_memory` and `update_memory` write **directly into Qdrant** — there's no filesystem for the browser to write markdown files to. This is a deliberate fallback, not the normal design: server mode treats markdown as the durable source of truth and Qdrant as a disposable, rebuildable index. Memories saved in local mode:

- **are** fully searchable/recallable in either mode afterward (same collection naming, `jarvis_memory_<client_id>`)
- **are not** visible in the Settings → Memory browse/edit panel (that reads markdown files)
- **will not** be recovered by a "reindex all" if you later switch to server mode, since there's nothing to reindex from

If you rely on browsing/editing/audit history of your memories, run server mode.

---

## Core modes

Switch between these via the `?mode=` URL param or the in-app switcher:

1. **Corrector** — paste text, the model proofreads it; view the clean result or a word-level diff.
2. **Chat** — multi-turn conversation with history, web search injection (Brave API), file/image/audio attachments, and tool calling.
3. **Image** — image generation via an OpenAI-compatible `/v1/images/generations` endpoint or Ollama's native `/api/generate`.
4. **Rag** — manage, ingest into (server mode only), and search Qdrant collections.

---

## Why `lib/` is vendored, not CDN-loaded

The libraries under `html/lib/` (Marked, KaTeX, JSZip, PDF.js) are committed as files rather than loaded from cdnjs/jsdelivr/unpkg. This is a deliberate choice for this project specifically, not a general rule:

- **Local mode has to work offline.** The whole point of local mode is that it runs with zero setup, including opening `index.html` directly via `file://` with no internet connection at all. A CDN `<script src>` breaks that guarantee the moment there's no network — markdown rendering, math, PDF ingestion, and zip export would silently stop working for anyone running this airgapped.
- **This is a privacy-oriented tool.** The whole pitch is "your inference stays local." A CDN request on every page load leaks the visitor's IP and usage pattern to a third party, which cuts against that.
- **The classic CDN benefit (shared cross-site cache) no longer applies.** Modern browsers partition their cache per top-level site, so "the user probably already has this cached from another site" isn't true anymore — a CDN mostly just adds a dependency on a third party being up and trustworthy, with none of the old upside.
- **Size is a non-issue.** All four libraries together are under 2 MB; GitHub doesn't care until well past 50 MB for a single file.

The tradeoff: updating a library means manually re-downloading the file instead of bumping a version string in an import tag. Worth it here.

Licenses and version tracking for everything under `lib/` live in [`html/lib/THIRD_PARTY_NOTICES.md`](html/lib/THIRD_PARTY_NOTICES.md). All of them (Marked, KaTeX, JSZip under its MIT option, PDF.js, and the Lucide icons used in the UI) are permissive licenses (MIT / ISC / Apache 2.0) that don't require any attribution to be shown in the app itself — only that the license notices are preserved somewhere in the repository, which that file does.

---

## Local mode: setup & usage

No installation. Pick one:

**Option A — open directly**
```
Just double-click html/index.html
```
The app detects `file://` and stays in local mode automatically.

**Option B — serve statically** (recommended — avoids some browsers' `file://` restrictions on fetch/CORS)
```bash
cd html
python3 -m http.server 8080
# → http://localhost:8080
```
Any static host works equally well (nginx, Caddy, GitHub Pages, a CDN, etc.) — there's no server-side logic to run.

### First-time configuration (local mode)

Open **Settings** in the app and set:

- **API flavor & base URL** — point at your running Ollama (`http://localhost:11434` by default), LM Studio, or OpenAI-compatible server. CORS must be enabled on that server for the browser to reach it directly (Ollama: `OLLAMA_ORIGINS=*`).
- **RAG → Qdrant URL** — only needed if you want RAG/memory. Requires Qdrant to have CORS enabled (`service.enable_cors: true` in Qdrant's config, or `QDRANT__SERVICE__ENABLE_CORS=true`), since the browser talks to Qdrant directly in local mode.
- **RAG → Embed model/flavor** — the embedding model to use for RAG and memory (shared pipeline). Requires Qdrant ≥ 1.10 (uses its Query API).

---

## Server mode: setup & usage

### Requirements

- Docker + Docker Compose
- A running Ollama / LM Studio / OpenAI-compatible inference server, reachable from the `backend` container

### Repo layout expected by `compose.yaml`

```
amarinthui/
├── Dockerfile
├── requirements.txt
├── compose.yaml
├── api/                 → mounted into the backend container at /app
│   ├── server.py
│   ├── rag.py
│   └── memory.py
├── html/                → served statically by nginx
│   └── ...
└── conf/
    └── nginx.conf        → nginx reverse-proxy config (not included in this repo snippet — see below)
```

> `compose.yaml` binds these from an absolute host path (`/DATA/AppData/dockge/stacks/amarinthui/...`), which is specific to the original deployment (Dockge on a NAS). **Edit the `source:` paths in `compose.yaml`** to match wherever you clone this repo before running it.

### `Dockerfile`

```dockerfile
FROM python:3.12-slim

WORKDIR /app

# Copy only requirements first — Docker caches this layer.
# pip install only re-runs when requirements.txt changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && pip uninstall -y pydub

# The rest of /app is bind-mounted at runtime, so no COPY needed for server.py.
# This image only needs to bake in the dependencies.

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
```

### `requirements.txt`

```
fastapi
uvicorn
httpx
python-multipart
markitdown[all]
qdrant-client
```

### `compose.yaml`

Three services:

- **`frontend`** — `nginx:latest`, serves `html/` statically and reverse-proxies API calls to `backend` so both live under one origin (this is what lets `fetch('/api/...')` calls in the frontend work without CORS juggling). Published on host port `8090`.
- **`backend`** — builds from the `Dockerfile` above, runs the FastAPI app (`server.py`) via `uvicorn` with `--reload`. Code is bind-mounted, not baked into the image, so edits to `api/*.py` take effect without a rebuild.
- **`qdrant`** — official `qdrant/qdrant` image. HTTP API + dashboard on `6333`, gRPC on `6334`. Storage bind-mounted for persistence across restarts.

```yaml
name: amarinthui
services:
  frontend:
    cpu_shares: 90
    command: []
    deploy:
      resources:
        limits:
          memory: "6442450944"
    image: nginx:latest
    container_name: amarinthui-frontend
    networks:
      - amarinthui
    depends_on:
      - backend
    ports:
      - mode: ingress
        target: 80
        published: "8090"
        protocol: tcp
    restart: unless-stopped
    volumes:
      - type: bind
        source: ./html
        target: /usr/share/nginx/html
        bind:
          create_host_path: true
      - type: bind
        source: ./conf/nginx.conf
        target: /etc/nginx/conf.d/default.conf
        bind:
          create_host_path: true
  backend:
    build:
      context: ./
      dockerfile: Dockerfile
    image: amarinthui-backend:latest
    restart: unless-stopped
    working_dir: /app
    volumes:
      - type: bind
        source: ./api
        target: /app
    networks:
      - amarinthui
    environment:
      - ORT_LOGGING_LEVEL=3
    depends_on:
      - qdrant # Added this to ensure DB starts before API
  qdrant:
    image: qdrant/qdrant:latest
    container_name: amarinthui-qdrant
    restart: unless-stopped
    networks:
      - amarinthui
    ports:
      - 6333:6333 # HTTP API and Dashboard
      - 6334:6334 # gRPC
    volumes:
      - type: bind
        source: ./qdrant_storage
        target: /qdrant/storage
        bind:
          create_host_path: true
    environment:
      - QDRANT__TELEMETRY_DISABLED=true
networks:
  amarinthui:
    driver: bridge
```

### Bring it up

```bash
git clone <this-repo> amarinthui
cd amarinthui
# Edit the `source:` bind paths in compose.yaml to point at this checkout
docker compose up -d --build
```

Then open **http://localhost:8090** (or whatever port you published). The frontend will detect the backend via `/api/health` and run in server mode automatically — no toggle to flip.

### Persistent data

- **Qdrant collections** — `qdrant_storage/` (bind-mounted, survives container restarts/rebuilds)
- **Chat history** — browser-side IndexedDB (`jarvis_db`), per browser/device, not server-side
- **Long-term memory markdown** — inside the backend container at `/app/memory/entries/<client_id>/`; back this path up (or bind-mount it) if you want it to survive a container recreation, since it isn't bind-mounted in the compose file above
- **Backend job state** — `/app/jobs` inside the backend container; same caveat as memory — not currently bind-mounted, so in-flight jobs are lost on container recreation (completed jobs are already synced into the browser's IndexedDB by then)

---

## Configuration reference

All settings live in the in-app **Settings** modal and persist to `localStorage` (so they follow the browser, not the mode):

| Setting | Purpose |
|---|---|
| API flavor / base URL | Which inference backend to talk to (Ollama / LM Studio / OpenAI-compatible) and where |
| RAG → Qdrant URL | Where Qdrant lives — used directly by the browser in local mode, and passed through to the backend in server mode |
| RAG → Embed model / flavor | Embedding model for both RAG and memory (one shared pipeline) |
| RAG → Field whitelist/blacklist | Which payload fields the `rag_search` tool exposes to the model |
| Memory → enabled / top-K / min score | Master switch and retrieval tuning for long-term memory |
| Tool Calling → built-ins, HTTP tools, MCP servers | What tools the model can call |
| Client ID override | Overrides the auto-generated client ID used to scope memory + route backend jobs/SSE — useful if you want a stable identity across browsers/devices |

---

## Known limitations of local mode

- **No job durability** — closing the tab mid-generation loses that in-flight response (server mode's job queue is what fixes this).
- **No RAG ingestion** — you can search an existing collection, but building one (PDF parsing, chunking strategies, batched upserts) requires the Python backend. Create/populate collections in server mode, then search them from either mode.
- **Memory writes are Qdrant-only** — see [note above](#a-note-on-local-mode-memory).
- **Requires CORS on your inference server and Qdrant** — server mode avoids this entirely by proxying everything same-origin through nginx; local mode talks to Ollama/Qdrant straight from the browser, so both need to explicitly allow cross-origin requests.

---

## Folder structure

```
amarinthui
├── api                    Python/FastAPI backend (server mode only)
│   ├── memory.py           Long-term memory: markdown + Qdrant, save/search/update
│   ├── rag.py               RAG: ingestion, chunking, Qdrant CRUD, search
│   └── server.py           API gateway, job manager, SSE, file persistence
└── html                   Frontend — works standalone or in front of the backend
    ├── api.js               Routes calls to the active API flavor
    ├── backend.js           Backend health check, job sync, SSE reconnect
    ├── chat.js               Chat UI, streaming, attachments, IndexedDB history
    ├── config.js             Settings/localStorage, constants, prompts
    ├── corrector.js         Text Corrector mode
    ├── fileblocks.js        Streaming-safe <jarvis_file> tag rendering
    ├── image.js              Image generation UI + gallery
    ├── index.html
    ├── lib/                 Vendored deps (marked, KaTeX, pdf.js, JSZip)
    │   └── THIRD_PARTY_NOTICES.md   Licenses + version tracking for lib/
    ├── lmstudio.js          LM Studio API client
    ├── main.js               Global state, mode routing
    ├── memory.js             Long-term memory: retrieval, injection, direct-mode fallback
    ├── ollama.js             Ollama API client
    ├── openai.js             OpenAI-compatible API client
    ├── rag.js                 RAG UI + client (direct-mode fallback for search/list)
    ├── settings.js           Settings modal
    ├── status-panel.js      Backend jobs panel
    ├── styles.css
    └── tools.js               Tool-calling engine: built-ins, HTTP tools, MCP
```

---

## License

MIT — see [`LICENSE`](LICENSE).

All dependencies, frontend and backend, are permissively licensed (MIT / BSD / Apache-2.0 / ISC) — see [`html/lib/THIRD_PARTY_NOTICES.md`](html/lib/THIRD_PARTY_NOTICES.md) for the vendored frontend libraries. Backend dependencies (`requirements.txt`): FastAPI (MIT), Uvicorn (BSD-3-Clause), httpx (BSD-3-Clause), python-multipart (Apache-2.0), MarkItDown (MIT), pypdf (BSD-3-Clause), qdrant-client (Apache-2.0).

> **Note:** an earlier version of this project's PDF ingestion used `pymupdf4llm`, which is AGPL-3.0/commercial dual-licensed. It's been removed (along with the one ingestion strategy that depended on it) specifically so the whole project can stay MIT with no copyleft entanglement. PDF ingestion now goes through `pypdf`/MarkItDown instead.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) — covers the code-of-conduct expectations, PR process, and a few architecture constraints specific to this codebase (shared global scope + script load order, and the local-mode/server-mode parity pattern) that are worth reading before making non-trivial changes.
