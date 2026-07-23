# Changelog

## 0.47.1 (2026-07-23)

### cloudflare-workers: false-positive fixes from first dogfood run
- **Fixed**: `env.X` references satisfied by an `Env` interface/type (including intersection types like `type ProviderEnv = Env & {...}`) but absent from wrangler config are now **info** ("secret-binding" — the normal shape of `wrangler secret put` secrets, listed for audit), not errors. Only names declared *nowhere* (config, Env types, `.dev.vars`) remain errors — the true-typo case.
- **Fixed**: `[vars]` secret detection now requires a credential-shaped value too — mode-selector vars like `AUTH_MODE = "cloudflare-access"` are no longer flagged.

## 0.47.0 (2026-07-23)

### New check: cloudflare-workers (advisory, component-gated)
- **Added**: the first component check, gated on `appliesTo { component: ["cloudflare-workers"] }` (schema 0.3.1). Audits wrangler config and worker code together: secrets committed in `[vars]` (error), bindings declared-but-unused (warning) and used-but-undeclared (error — production crash), cron triggers without a `scheduled()` handler (error), `node:` imports without `nodejs_compat` (error), stale/missing `compatibility_date` (warning), missing `main` entry (error). Workspace-aware; `details` carries structured `bindingsDeclared`/`bindingsUsed` for UI panels. Weight 0 while the rules bed in.
- **Changed**: package description no longer hardcodes a check count.

## 0.46.0 (2026-07-23)

### Component detection (schema 0.3.0)
- **Added**: `detectComponents` — the scan now recognizes infrastructure/data components and reports them in `meta.stack.components` (open vocabulary): `cloudflare-workers` / `cloudflare-pages` (wrangler config), `sqlite-d1` (D1 bindings or `migrations/*.sql`), `cloudflare-kv`, `cloudflare-r2`, `durable-objects`. Workspace-aware (checks package dirs too).
- **Added**: central gating now honors `appliesTo.component` (conjunction — every listed component must be present), enabling component checks (`cloudflare-workers`, `sqlite-d1`) and composition checks (e.g. react + workers + d1) to come.
- **Added**: `fixtures/worker-d1-app` e2e tripwire — a real Worker+D1+KV project must detect correctly and scan without runner crashes.

## 0.45.1 (2026-07-23)

### Fixes
- **Fixed**: `--diff` was silently a no-op in the ESM build — `getChangedFiles` used `require("node:child_process")`, which throws in ESM and was swallowed by its catch, so diff filtering never applied. Now a static import, and the git call uses an argv array.
- **Fixed**: `pnpm lint` is green again — regex `exec()` while-loops converted to `matchAll()` (noAssignInExpressions), mechanical style fixes applied. Complexity warnings remain as known refactor debt.
- **Docs**: CLAUDE.md check/weight table corrected against `@vibecodeqa/schema` (Quality 30 incl. the 0.43.0 checks, Testing 13, AI Readiness 9).

## 0.45.0 (2026-07-23)

### Declarative stack gating (appliesTo)
- **Added**: checks now declare which stacks they apply to via `CheckMeta.appliesTo` (from `@vibecodeqa/schema@0.2.0`); the scan core gates centrally and emits a standard skipped result (`not applicable to this stack`). First gated check: `react`.
- **Changed**: React-specific logic evicted from generic checks — the Error Boundary warning + flat 5-point penalty moved from `error-handling` into `react`, and the Tailwind inline-style warning moved from `standards` into `react`. Rule going forward: a check is either stack-gated or stack-blind, never stack-branching inside.
- **Score movement**: React projects without an Error Boundary — `error-handling` rises by up to 5, `react` drops by 5; composite impact is small (react weight 3 vs error-handling 3). React+Tailwind projects with >10 inline styles shift one warning from `standards` to `react`.
- **Changed**: cli now consumes `@vibecodeqa/schema` ^0.2.0 (shared contract package).

## 0.44.5 (2026-07-09)

### Runner crash + false-positive fixes
- **Fixed**: the `git-hygiene` and `styling` runners called `require("node:fs")` in an ESM build, throwing `require is not defined` at runtime — both checks crashed instead of reporting. Switched to static ESM imports; both now run normally.
- **Fixed**: gitleaks scanned the CLI's own generated `.vibe-check/` report HTML (which embeds sample keys), flooding the `secrets` check with dozens of false "Generic API Key" findings. Findings under `.vibe-check/` are now excluded.

## 0.44.4 (2026-07-08)

### Configurable ignore
- **Improved**: ignore entries (`VCQA_IGNORE` / `ignoreNames`) containing a slash — e.g. `src/generated` — now match that slash-bounded sub-path anywhere in the tree, instead of silently matching nothing. Bare names still match per path segment. Keeps the CLI in parity with the monitor's watcher and graph filters.

## 0.44.3 (2026-07-08)

### Configurable ignore
- **Added**: `VCQA_IGNORE` env var and a `ScanOptions.ignoreNames` option — extra directory/file *names* skipped during file collection (segment match, same gate as the built-in `SKIP_DIRS`). This lets the VibeCode Monitor push its user-configurable "Ignored paths" into the scan, so the file watcher, the graphs, and the report all exclude the same folders. Non-intrusive: nothing is written into the scanned repo.

## 0.44.2 (2026-07-08)

### Duplication fix
- **Fixed**: Framework build/cache directories are now skipped during file collection, so generated bundles are no longer scanned or flagged as duplicates of the real source. Cloudflare's `.wrangler/tmp/bundle-*/` (which mirrors `src` into `middleware-loader.entry.ts`) was the reported case; also added `.vercel`, `.turbo`, `.svelte-kit`, `.astro`, `.cache`, and `.parcel-cache` to `SKIP_DIRS`.

## 0.44.1 (2026-07-08)

### Duplication fix
- **Fixed**: Overlapping source roots (e.g. `app/src` nested under a catch-all `app`) caused files to be walked twice, so the duplication check matched each file against its own copy and reported bogus self-clones (`file:8 ↔ file:8`) and inflated duplication percentages. `pruneNestedRoots` now drops any root nested under another before walking, and file collection dedupes by absolute path.

## 0.44.0 (2026-06-07)

### Monorepo fixes
- **Fixed**: Lint, testing, and styling runners now scan from `.` when `src/` doesn't exist (instead of silently skipping files)
- **Fixed**: `bun.lock` (text format, Bun 1.2+) recognized as a valid lockfile alongside `bun.lockb`
- **Fixed**: `tsconfig.json` strict mode detected in workspace packages, not just root
- **Fixed**: Confusion check — eliminated false positives from cross-package similar filenames, short-name Levenshtein matches (meta↔cta), and cross-package export collisions
- **Fixed**: Standards check — detects dominant file naming convention (kebab-case vs PascalCase) before flagging
- **Fixed**: Lint results filter out `.vibe-check/` generated files
- **Tuned**: Large-file penalty reduced (multiplier 5→3) for fairer monorepo scoring

### Delta reports (new)
- `vcqa fix` now runs baseline scan → fixes → final scan → shows before/after delta
- Delta saved to `.vibe-check/delta.md` after every fix run
- `--markdown` and `--pr-comment` outputs include per-check score changes and fixed/new issue counts
- New programmatic API: `computeDelta(before, after)` and `formatDeltaMarkdown(delta)` exported from `@vibecodeqa/cli/core`

### Actions page (new)
- New "Actions" page in the HTML report showing recommended fixes grouped by type:
  - **Quick Fixes** — auto-fixable with `vcqa fix` (lint, missing files, config)
  - **AI Fixes** — fixable with `vcqa fix --ai` (grouped by action with affected files)
  - **Manual Actions** — grouped by check with recommendations
- "What Changed" delta banner at top when previous scan exists
- Accessible from top nav between Trends and Issues

### MCP
- New `vcqa_delta` tool — compares current scan against previous, shows score changes and fixed/new issues

## 0.43.0 (2026-06-06)

### New checks
- HTML Quality — static site scanner (meta tags, broken links, heading hierarchy)
- Frontend Health — UI framework conflicts, mixed icons, unoptimized images
- Styling — hardcoded colors, mixed approaches, !important abuse
- Env Validation — .env hygiene, .env.example drift
- Git Hygiene — merge conflicts, commit quality, large/binary files
- Memory Safety — interval/listener leaks, global pollution
- Container Health — Dockerfile best practices, .dockerignore, pinned images
- File Cohesion (Pro) — files mixing multiple responsibilities
- Design Consistency (Pro) — visual inconsistency across components
