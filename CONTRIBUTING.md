# Contributing to RubyUI

Thanks for considering a contribution. This project aims to stay genuinely open — no CLA, no copyleft you didn't sign up for, no dependency on services you have to trust. Please help keep it that way.

## Code of Conduct

Be respectful, assume good faith, keep disagreements about the code and not the person. If you've used a project with a [Contributor Covenant](https://www.contributor-covenant.org/)-style code of conduct before, that's the spirit — this project doesn't currently have a separate `CODE_OF_CONDUCT.md`; open an issue if you think it needs one.

## Before you open a PR

- **For anything non-trivial, open an issue first.** Bug fixes, small docs edits, and typo fixes can go straight to a PR. New features, architectural changes, or anything touching more than one or two files benefits from a quick discussion first, so you're not surprised by feedback after doing the work.
- **Keep PRs scoped.** One feature or fix per PR. Easier to review, easier to revert if something's wrong.
- **Describe how you tested it.** There's no automated test suite yet (see [Areas that need help](#areas-that-need-help)), so PR descriptions should say what you actually ran — which mode (local/server), which browser, what you clicked through.

## Architecture constraints that matter for PRs

This codebase has a few characteristics that aren't obvious from reading a single file in isolation — please read these before making changes, since they've caused real bugs in this project's history.

### 1. No build step — shared global scope, strict load order

`html/*.js` files are plain `<script>` tags loaded in a specific order (see the top of `index.html` and the comment block at the top of most `.js` files). There's no bundler, no modules, no imports — every file's top-level functions/`const`s land in one shared global scope, and files later in the load order can freely reference things defined by files earlier in it.

**If you add a new `.js` file:**
- Add a `<script src="...">` tag for it in `index.html`, in the correct position — check what it depends on and what depends on it.
- Say explicitly in your PR description where you placed it and why.
- A misplaced script tag doesn't always fail loudly — it can silently break unrelated buttons elsewhere on the page because of how errors propagate through shared-scope initialization. If something stops responding after your change, check the browser console for an error near the top of the log before assuming it's unrelated to your PR.

### 2. Local mode and server mode need to both keep working

This project's whole premise is that it works with **zero backend** (open `index.html`, done) and *also* works with the full Docker Compose stack — and both modes share the exact same frontend code, switching behavior based on whether `/api/health` responds (`BACKEND_AVAILABLE`).

**If you add a feature that talks to Qdrant, Ollama, or any other service the backend also talks to:** please add a direct/local-mode code path alongside the backend path, not just the backend path. The established pattern (see `rag.js`'s `_ragDirectMode()` / `_ragSearchDirect()`, or `memory.js`'s `executeSaveMemoryTool()`) is:

```js
if (typeof BACKEND_AVAILABLE === 'undefined' || !BACKEND_AVAILABLE) {
  // talk to Ollama/Qdrant directly from the browser
} else {
  // existing /api/... fetch to the backend, unchanged
}
```

A feature that only works in server mode is a regression for local-mode users, even if it "still works" for you testing against the full stack. If a feature genuinely *can't* have a local-mode equivalent (e.g. it needs the filesystem, or heavy PDF/OCR processing), that's fine — just say so in the PR and it'll be documented as backend-only, the same way RAG ingestion is today.

### 3. License boundaries — check before adding a dependency

This project is MIT-licensed specifically because its dependencies are all permissive licenses (MIT/BSD/Apache/ISC — see `html/lib/THIRD_PARTY_NOTICES.md` for the frontend ones). **Before adding a new Python or JS dependency, check its license.** Copyleft licenses (GPL, AGPL, LGPL) aren't automatically disqualifying, but they change what license the resulting code can carry, so flag it in your PR description rather than letting it get discovered in review. This project previously depended on an AGPL-licensed PDF library for one feature; that feature was removed specifically to keep the whole project MIT — the same tradeoff would apply to anything similar.

If you vendor a new frontend library into `html/lib/`, add it to `html/lib/THIRD_PARTY_NOTICES.md` with its license and version.

## Development setup

There's no build step, so "development setup" is just running the app:

- **Frontend-only changes:** serve `html/` locally (`python3 -m http.server` from inside `html/`) and test in local mode — fastest iteration loop, no Docker needed.
- **Backend changes:** `docker compose up -d --build` per the main README, then edit files under `api/` — the backend container bind-mounts `api/` and runs with `--reload`, so changes take effect without a rebuild.
- Test **both modes** if your change touches anything that could plausibly run in either (see above).

## Commit / PR conventions

- No CLA. By opening a PR, you're agreeing your contribution is licensed under this project's MIT license (see `LICENSE`) — same as the rest of the codebase.
- Sign off your commits (`git commit -s`) with a [Developer Certificate of Origin](https://developercertificate.org/) statement if you're comfortable doing so. Not currently enforced by CI, but it's good practice and may become required later.
- Write commit messages that explain *why*, not just *what*, where it's not obvious from the diff.

## Areas that need help

If you're looking for a place to start:

- **Automated tests.** There currently aren't any. Even a basic smoke-test harness (headless browser hitting local mode, verifying core buttons respond) would be a meaningful contribution.
- **Accessibility.** Not currently audited.
- **Additional API flavors** beyond Ollama/LM Studio/OpenAI-compatible.
- Check open issues for anything tagged `good first issue` or `help wanted`.

## Reporting bugs / requesting features

Open a GitHub issue. For bugs, include: which mode (local/server), browser + OS, steps to reproduce, and — if it's a "nothing responds" type issue — the browser console output (see the [Troubleshooting](README.md#troubleshooting) section of the README for the most common cause of that).
