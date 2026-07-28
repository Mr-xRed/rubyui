# ══ MEMORY.PY ═══════════════════════════════════════════════════
# Long-term memory backend for Jarvis. Scoped per Client ID — the same
# Client ID already used to route backend jobs/SSE to the right browser
# (see server.py's get_client_id() / X-Client-ID header, config.js's
# BACKEND_CLIENT_ID_OVERRIDE). Each distinct client gets its own markdown
# folder and its own Qdrant collection, so memories never mix between
# users/instances that share one backend deployment.
#
# Storage model (deliberately dual-layer), per client_id:
#   - SOURCE OF TRUTH: plain markdown files under
#     /app/memory/entries/<client_id>/<entry_id>.md, with a small
#     YAML-ish frontmatter header. Human-readable, diffable, trivially
#     backupable (rsync/git/tar the folder — one subfolder per client).
#   - INDEX: one Qdrant collection per client ("jarvis_memory_<client_id>")
#     holding the same entries, embedded, for fast semantic retrieval.
#     Rebuildable from the markdown files at any time (see reindex_all
#     below) — the index is disposable, the markdown is not.
#
# Reuses rag.py's embedding + Qdrant helpers so there is exactly one
# embedding pipeline in the codebase, not two.
#
# Mount into server.py with:
#   from memory import memory_router, memory_save, SaveMemoryRequest
#   app.include_router(memory_router)

import json, re, time, uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from rag import _embed, _get_qdrant  # reuse the one embedding pipeline

try:
    from qdrant_client.models import Distance, VectorParams, PointStruct, PointIdsList
    _QDRANT_OK = True
except ImportError:
    _QDRANT_OK = False

MEMORY_ROOT = Path("/app/memory/entries")
MEMORY_ROOT.mkdir(parents=True, exist_ok=True)

memory_router = APIRouter(prefix="/api/memory", tags=["memory"])


# ── Client scoping ───────────────────────────────────────────────
# Same header server.py's get_client_id() reads for job routing — kept as
# an independent copy here (rather than importing from server.py) since
# server.py is the one importing FROM this module; importing back would
# be circular.

def _client_id_from_request(req: Request) -> str:
    return req.headers.get("x-client-id", "anonymous")


def _sanitize_client_id(client_id: str) -> str:
    """Collapses a Client ID down to something safe to use both as a
    filesystem folder name and a Qdrant collection name. Falls back to
    'anonymous' for empty/invalid input rather than silently pooling
    everyone into one collection."""
    slug = re.sub(r"[^a-zA-Z0-9_-]", "_", (client_id or "").strip())
    slug = slug.strip("_")[:64]
    return slug or "anonymous"


def _collection_name(client_id: str) -> str:
    return f"jarvis_memory_{_sanitize_client_id(client_id)}"


def _memory_dir(client_id: str) -> Path:
    d = MEMORY_ROOT / _sanitize_client_id(client_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── Markdown persistence (source of truth) ─────────────────────

def _entry_path(client_id: str, entry_id: str) -> Path:
    return _memory_dir(client_id) / f"{entry_id}.md"


def _write_entry_md(client_id: str, entry: dict):
    fm = (
        "---\n"
        f"id: {entry['id']}\n"
        f"created: {entry['created']}\n"
        f"updated: {entry['updated']}\n"
        f"source: {entry.get('source', '')}\n"
        f"tags: {json.dumps(entry.get('tags', []), ensure_ascii=False)}\n"
        f"confidence: {entry.get('confidence', 'stated')}\n"
        "---\n\n"
    )
    _entry_path(client_id, entry["id"]).write_text(fm + entry["text"].strip() + "\n", encoding="utf-8")


_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n\n?(.*)$", re.DOTALL)


def _read_entry_md(client_id: str, entry_id: str) -> dict | None:
    p = _entry_path(client_id, entry_id)
    if not p.exists():
        return None
    raw = p.read_text(encoding="utf-8")
    m = _FRONTMATTER_RE.match(raw)
    if not m:
        return {"id": entry_id, "text": raw.strip(), "tags": [], "source": "",
                 "confidence": "stated", "created": "", "updated": ""}
    header, body = m.groups()
    meta = {}
    for line in header.splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        meta[k.strip()] = v.strip()
    try:
        tags = json.loads(meta.get("tags", "[]"))
    except Exception:
        tags = []
    return {
        "id": entry_id,
        "text": body.strip(),
        "created": meta.get("created", ""),
        "updated": meta.get("updated", ""),
        "source": meta.get("source", ""),
        "tags": tags,
        "confidence": meta.get("confidence", "stated"),
    }


def _delete_entry_md(client_id: str, entry_id: str):
    p = _entry_path(client_id, entry_id)
    if p.exists():
        p.unlink()


# ── Qdrant index helpers ────────────────────────────────────────

async def _ensure_memory_collection(client_id: str, qdrant_url: str, dim: int):
    """Create this client's collection on first use. Safe under light
    concurrency — a create-after-exists race just gets swallowed (Qdrant
    already has it)."""
    coll = _collection_name(client_id)
    client = _get_qdrant(qdrant_url)
    try:
        client.get_collection(coll)
    except Exception:
        try:
            client.create_collection(
                collection_name=coll,
                vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
            )
        except Exception:
            pass  # created concurrently by another request
    return client


def _upsert_point(client, client_id: str, entry: dict, vector: list[float]):
    client.upsert(
        collection_name=_collection_name(client_id),
        points=[PointStruct(
            id=entry["id"],
            vector=vector,
            payload={
                "text":       entry["text"],
                "tags":       entry.get("tags", []),
                "source":     entry.get("source", ""),
                "confidence": entry.get("confidence", "stated"),
                "created":    entry.get("created", ""),
                "updated":    entry.get("updated", ""),
            },
        )],
        wait=True,
    )


# ── Save (create) ───────────────────────────────────────────────

class SaveMemoryRequest(BaseModel):
    text: str
    tags: list[str] = []
    source: str = "manual"          # e.g. a chat_id, or "manual"
    confidence: str = "stated"      # "stated" | "inferred"
    embed_model: str = "nomic-embed-text"
    embed_flavor: str = "ollama"
    ollama_base: str = "http://localhost:11434"
    qdrant_url: str = "http://localhost:6333"


async def memory_save(client_id: str, req: SaveMemoryRequest) -> dict:
    """Core save logic. Importable directly by server.py so the save_memory
    tool call can write memory server-side without an HTTP round-trip to
    itself (same pattern as rag_search_chunks / run_image_generation)."""
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "text must not be empty")

    entry_id = str(uuid.uuid4())
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    entry = {
        "id": entry_id, "text": text, "created": now, "updated": now,
        "source": req.source, "tags": req.tags, "confidence": req.confidence,
    }
    # Markdown write happens first and unconditionally — it's the source of
    # truth. If embedding/Qdrant fails below, the memory is not lost, just
    # not yet searchable until a reindex.
    _write_entry_md(client_id, entry)

    if not _QDRANT_OK:
        return {"id": entry_id, "saved": True, "indexed": False, "error": "qdrant-client not installed"}

    try:
        vecs = await _embed([text], req.embed_model, req.ollama_base, req.embed_flavor)
        client = await _ensure_memory_collection(client_id, req.qdrant_url, len(vecs[0]))
        _upsert_point(client, client_id, entry, vecs[0])
    except Exception as e:
        return {"id": entry_id, "saved": True, "indexed": False, "error": str(e)}

    return {"id": entry_id, "saved": True, "indexed": True}


@memory_router.post("/save")
async def save_memory_endpoint(req: SaveMemoryRequest, request: Request):
    return await memory_save(_client_id_from_request(request), req)


# ── Update ───────────────────────────────────────────────────────

class UpdateMemoryRequest(BaseModel):
    text: str | None = None
    tags: list[str] | None = None
    confidence: str | None = None
    embed_model: str = "nomic-embed-text"
    embed_flavor: str = "ollama"
    ollama_base: str = "http://localhost:11434"
    qdrant_url: str = "http://localhost:6333"


async def memory_update(client_id: str, entry_id: str, req: UpdateMemoryRequest) -> dict:
    """Core update logic. Importable directly by server.py so the
    update_memory tool call can edit memory server-side without an HTTP
    round-trip to itself (same reasoning as memory_save)."""
    existing = _read_entry_md(client_id, entry_id)
    if not existing:
        raise HTTPException(404, "memory entry not found")

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    entry = {
        **existing,
        "text":       (req.text.strip() if req.text is not None and req.text.strip() else existing["text"]),
        "tags":       req.tags if req.tags is not None else existing["tags"],
        "confidence": req.confidence if req.confidence is not None else existing["confidence"],
        "updated":    now,
    }
    _write_entry_md(client_id, entry)

    if not _QDRANT_OK:
        return {"id": entry_id, "saved": True, "indexed": False}
    try:
        vecs = await _embed([entry["text"]], req.embed_model, req.ollama_base, req.embed_flavor)
        client = await _ensure_memory_collection(client_id, req.qdrant_url, len(vecs[0]))
        _upsert_point(client, client_id, entry, vecs[0])
    except Exception as e:
        return {"id": entry_id, "saved": True, "indexed": False, "error": str(e)}
    return {"id": entry_id, "saved": True, "indexed": True, "text": entry["text"]}


@memory_router.put("/{entry_id}")
async def update_memory(entry_id: str, req: UpdateMemoryRequest, request: Request):
    return await memory_update(_client_id_from_request(request), entry_id, req)


# ── Delete ───────────────────────────────────────────────────────

@memory_router.delete("/{entry_id}")
def delete_memory(entry_id: str, request: Request, qdrant_url: str = "http://localhost:6333"):
    client_id = _client_id_from_request(request)
    _delete_entry_md(client_id, entry_id)
    if _QDRANT_OK:
        try:
            client = _get_qdrant(qdrant_url)
            client.delete(collection_name=_collection_name(client_id), points_selector=PointIdsList(points=[entry_id]))
        except Exception:
            pass  # markdown deletion already succeeded; index may lag until reindex
    return {"ok": True}


# ── List (for the Settings management UI) ─────────────────────────

@memory_router.get("/list")
def list_memory(request: Request):
    client_id = _client_id_from_request(request)
    d = _memory_dir(client_id)
    entries = [e for e in (_read_entry_md(client_id, p.stem) for p in d.glob("*.md")) if e]
    entries.sort(key=lambda e: e.get("updated", ""), reverse=True)
    return {"entries": entries, "count": len(entries)}


# ── Search ───────────────────────────────────────────────────────

class SearchMemoryRequest(BaseModel):
    query: str
    top_k: int = 5
    score_threshold: float = 0.0   # 0 = no filtering; qdrant cosine score, higher = more similar
    embed_model: str = "nomic-embed-text"
    embed_flavor: str = "ollama"
    ollama_base: str = "http://localhost:11434"
    qdrant_url: str = "http://localhost:6333"


@memory_router.post("/search")
async def search_memory_endpoint(req: SearchMemoryRequest, request: Request):
    results = await memory_search_chunks(
        client_id=_client_id_from_request(request),
        query=req.query, embed_model=req.embed_model, embed_flavor=req.embed_flavor,
        ollama_base=req.ollama_base, qdrant_url=req.qdrant_url, top_k=req.top_k,
        score_threshold=req.score_threshold,
    )
    return {"results": results}


async def memory_search_chunks(
    client_id: str, query: str, embed_model: str, embed_flavor: str, ollama_base: str,
    qdrant_url: str, top_k: int = 5, score_threshold: float = 0.0,
) -> list[dict]:
    """Module-level search helper, importable by server.py — mirrors
    rag.py's rag_search_chunks(). Returns [] gracefully if this client
    hasn't saved anything yet (collection doesn't exist) rather than
    erroring. score_threshold (0 = disabled) drops low-relevance matches
    before they ever reach the model — same mechanism as rag.py's /search
    endpoint."""
    if not _QDRANT_OK or not query:
        return []
    try:
        vecs = await _embed([query], embed_model, ollama_base, embed_flavor)
        client = _get_qdrant(qdrant_url)
        coll = _collection_name(client_id)
        try:
            client.get_collection(coll)
        except Exception:
            return []  # nothing saved yet for this client
        response = client.query_points(
            collection_name=coll, query=vecs[0], limit=top_k, with_payload=True,
            score_threshold=score_threshold if score_threshold > 0 else None,
        )
        return [
            {"id": str(r.id), "score": round(r.score, 4), **(r.payload or {})}
            for r in response.points
        ]
    except Exception:
        return []


# ── Reindex (rebuild Qdrant from markdown — the whole point of the
#   dual-layer design: the index is disposable) ─────────────────────

class ReindexRequest(BaseModel):
    embed_model: str = "nomic-embed-text"
    embed_flavor: str = "ollama"
    ollama_base: str = "http://localhost:11434"
    qdrant_url: str = "http://localhost:6333"


@memory_router.post("/reindex")
async def reindex_all(req: ReindexRequest, request: Request):
    """Re-embeds every markdown entry belonging to this client and rebuilds
    their collection from scratch. Use after editing markdown files by
    hand, restoring from a backup, or changing the embedding model."""
    client_id = _client_id_from_request(request)
    d = _memory_dir(client_id)
    entries = [e for e in (_read_entry_md(client_id, p.stem) for p in d.glob("*.md")) if e]
    if not entries:
        return {"reindexed": 0}
    if not _QDRANT_OK:
        raise HTTPException(503, "qdrant-client not installed")

    texts = [e["text"] for e in entries]
    vecs = await _embed(texts, req.embed_model, req.ollama_base, req.embed_flavor)

    client = _get_qdrant(req.qdrant_url)
    coll = _collection_name(client_id)
    try:
        client.delete_collection(coll)
    except Exception:
        pass
    client.create_collection(
        collection_name=coll,
        vectors_config=VectorParams(size=len(vecs[0]), distance=Distance.COSINE),
    )
    points = [
        PointStruct(id=e["id"], vector=v, payload={
            "text": e["text"], "tags": e.get("tags", []), "source": e.get("source", ""),
            "confidence": e.get("confidence", "stated"), "created": e.get("created", ""),
            "updated": e.get("updated", ""),
        })
        for e, v in zip(entries, vecs)
    ]
    client.upsert(collection_name=coll, points=points, wait=True)
    return {"reindexed": len(points)}
