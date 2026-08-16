# Changelog

## 0.55.1 (2026-08-17)

### A tool that never ran is no longer an A
A missing Dart SDK scored `lint` and `types` at A/100. `2>/dev/null || true`
turned "the toolchain is absent" into "the toolchain found nothing", so the
scanner reported health it had not measured — the worst failure mode a
code-quality tool has.
- **Fixed**: `hasDartSdk()` (new `runners/toolchain.ts`) probes once per scan
  with a bare `dart --version` and no `|| true`. `lint`, `types` and
  `dependencies` now return `unavailable` instead of a score, excluded from the
  composite rather than inflating it (#92). Scores on machines that *do* have
  Dart are unchanged.
- **Note for consumers**: an excluded check still serialises as
  `score: 100, grade: "A"`. Read `status`/`scoreMode`/`scoreImpact`, never
  `grade`. Seven further `|| true` sites that can still fabricate a clean pass
  are catalogued on #92 and tracked by #26.

### Also in this release
- **Fixed**: React Compiler diagnostics route to `compiler-readiness` instead of
  being bucketed as `hooks`, which had left that check permanently empty (#89).
- **Fixed**: the standards runner no longer re-flattens dangerous-API findings
  that `security.ts` already owns (#62).
- **Fixed**: `<html lang>` and viewport meta have a single owner (#68).
- **Security**: 6 advisories (4 high) cleared in the vitest -> vite dev chain;
  `pnpm audit` reports no known vulnerabilities (#93).

## 0.55.0 (2026-08-09)

### One file universe, one ignore engine
A runner could previously decide for itself which files existed. That is why a
scan could report `dangerouslySetInnerHTML` in `dist/`, JSDoc gaps in
`.claude/worktrees/`, or hardcoded colours in a config-ignored folder — each
walker applied its own approximation of the ignore rules, and they disagreed.
- **Changed**: `evaluatePath()` is now the only implementation of the ignore
  rules. `fs-utils` no longer keeps a second copy of the directory names, glob
  matching and file patterns; the shared walkers and `isIgnoredPath()` — the
  filter applied to Biome/ESLint/tsc/gitleaks output — both answer from the
  scan's own `EffectiveScanPolicy`. An external tool and the file walk can no
  longer disagree about what the scan may see (#71).
- **Changed**: the five remaining runners that discovered files themselves —
  `secrets`, `best-practices`, `duplication`, `test-audit`, `flutter` — now
  consume the scan-wide `FileInventory`. Every runner that scans repo content
  takes it; what still walks (external tool adapters, targeted reads of known
  paths, `dependencies` inspecting `node_modules` on purpose) is documented in
  `docs/exclusion-policy.md` (#70).
- **Added**: `FileInventory` carries the policy it was built from, plus
  `inventoryIsIgnored` / `inventoryClassify` / `inventoryExplain` /
  `inventoryHas`, so a runner can classify or explain a path the walk never
  produced. `explainPath()` renders any decision as one line of prose.
- **Added**: the inventory retains the files the walk reached and the policy
  rejected, with their reason codes. Ignored *directories* are still pruned
  whole, so the list stays small. This exists for checks that *measure* excluded
  files — `flutter`'s generated-to-handwritten Dart ratio needs `*.g.dart` — and
  replaces that runner's private walk.
- **Added**: `meta.fileInventory.ignoredByReason` — counts of what the scan
  skipped and why, alongside the existing counts by class.
- **Added**: a whole-scan conformance test. It runs a scan over a fixture seeded
  with `dist/`, `coverage/`, `playwright-report/`, `node_modules/`,
  `.claude/worktrees/`, a config-ignored directory, a lockfile and a minified
  bundle, then asserts that no finding from any check names an excluded path and
  that every finding names a file the inventory holds.
- **Note**: a security-sensitive file that is only ignored by project config
  (a committed `.env`) is no longer hidden from secrets checks. That is the
  policy's security override working as designed.

### Also in this release
- **Fixed**: accessibility counted a button labelled by a JSX expression as
  having no visible text (#87).
- **Fixed**: security now grades `dangerouslySetInnerHTML` by the provenance of
  the HTML rather than flagging every use (#86).

## 0.53.1 (2026-07-26)

### Fixed — bugs found auditing the 0.53.0 zero-config Biome lint fallback
- **Fixed**: the fallback scored files the rest of the scan never looked at. The file walker skips hidden directories (`entry.startsWith(".")`), but Biome descends into `.github/`, `.storybook/`, etc., and `isIgnoredPath` (the filter meant to mirror the walker) didn't replicate the hidden-dir rule — so a `.github/scripts/deploy.ts` could drop the lint score of a repo whose `src/` is clean, contradicting `meta.filesScanned`. `isIgnoredPath` now also ignores any hidden path segment.
- **Fixed**: a single unparseable file exploded into many `error`-severity diagnostics (Biome emits one `parse` error per failure *within* a file), sinking the whole lint score. Parse diagnostics are now collapsed to one issue per file.
- **Fixed**: `detectLintInCI` matched a bare `check` token, so a workflow that merely said "Check out the code" or "sanity check" was awarded an unearned lint score of 70/B. It now matches real lint invocations (`biome`/`eslint`/`lint`) only.
- **Fixed**: a broken symlink under a workspace glob directory (`packages/*`) made `statSync` throw out of `detectWorkspace` and abort the entire scan. `resolveGlob` now skips unreadable entries and symlinks like `walkForPackages` already did.

## 0.53.0 (2026-07-26)

### Lint no longer gives up when a project configures no linter
A project with no biome/eslint config, no lint script, and no linter in its deps previously scored lint **F/0 "no linter detected"** and produced no tool output — common for AI-generated apps. Lint now falls back to running **Biome's recommended rules with no config**, the same "works without install" approach already used for knip (dead code). Biome lints zero-config; ESLint can't (it errors without a config), so Biome is the fallback.
- **Added**: zero-config Biome fallback in the lint runner — when nothing configures a linter (and lint isn't detected in CI or sibling packages), it runs `npx @biomejs/biome lint` and reports a real lint score with `details.zeroConfig: true` and an honest reason. The `@biomejs/biome` run shows up in `details.toolRuns[]` like any other delegated tool. On a real unlinted app this turned an empty "skipped" into a concrete **D 45 (456 issues)**.
- **Changed**: the shared Biome JSON parsing and lint scoring were factored into `parseBiomeLint` / `scoreLint` (both unit-tested), used by the configured-Biome path and the fallback alike.

## 0.52.0 (2026-07-24)

### Reports can now be audited — tool provenance and scan size
A clean score was previously unfalsifiable: "the tool ran and found nothing", "the tool was never installed", and "the tool ran in the wrong directory" all produced identical output. The last one is not hypothetical — it reported 42 live modules as unused in 0.50.x.
- **Added**: every delegated tool run is recorded and attached to the check that made it — `details.toolRuns[]` with the tool name, the **exact command**, the **directory it ran in**, ok/failed, whether the binary was missing, duration, and its output (capped at 8 KB). Instrumented in the shared `exec.ts` wrapper, so knip, gitleaks, tsc, eslint, npm audit, dart analyze and jscpd all get it without per-runner work.
- **Added**: `meta.filesScanned` — how many source files the walk actually covered, so a result can be sanity-checked against project size.

## 0.51.0 (2026-07-24)

### Fixed — dead-code analysis ran from the wrong directory and reported live code as unused
- **Fixed**: knip was always run at the scan root. Its entry globs are relative to the directory holding its config, so a monorepo whose knip config lives in a package (`app/knip.config.ts`) gave knip **no reachable entry points** — it then called the entire package unreachable. On a real project this reported **42 live Cloudflare Pages Function modules as "unused files"** and 102 live exports as unused; a user acting on that would have deleted working production code. Knip now runs where its config lives (`knipRoots`), descending into workspace packages, with results path-prefixed back to the repo root. The same project now correctly reports **zero** dead code.
- **Added**: `details.deadCodeConfigured` — false when nothing configures knip, so consumers can say the entry points were guessed instead of presenting the output as fact.

## 0.50.0 (2026-07-24)

### Markdown report tells the whole truth
The summary listed only the checks that ran, so a reader concluded the product had ~20 checks and that all of them passed. It now reports coverage honestly:
- **Added**: a "Not applicable to this project" section (collapsed, so PR comments stay short) naming every gated check and *why* — `react: not applicable to this stack (requires framework: react)`, `sqlite-d1: requires component: sqlite-d1`, `container-health: no Dockerfile found`, and so on. The heading now reads "Checks that ran (21 of 36)".
- **Added**: a category rollup with weights, so it is visible that Testing carries 13 points and advisory checks carry none — a flat check list hid where the score comes from.
- **Added**: a stack/components line (`Components: cloudflare-workers`, monorepo tool) explaining which check set applied.
- **Added**: a note that Pro AI-analysis checks are advisory and excluded from the score, and a pointer to the multi-page HTML report — the markdown is the headline, not the whole story.

## 0.49.0 (2026-07-24)

### Fixed — dead-code detection reported zero for every project
- **Fixed**: `tryKnip` parsed Knip's *legacy* top-level JSON shape (`{files, exports, dependencies}`), but modern Knip emits `{ issues: [ { file, exports[], types[], dependencies[], files[] } ] }`. Every key read was `undefined`, so `deadExports` / `unusedFiles` / `unusedDeps` were **silently 0 on every scan** where Knip was installed, and the dead-code score penalty never applied. Both shapes are now parsed (`parseKnipJson`, unit-tested). Self-scan went from 0 to 31 unused exports and 3 unused dependencies.
- **Added**: `performance` details now carry the dead-code *items* (file, symbol, line), not just counts — `details.deadCode.{files,exports,types,deps}`, capped for report size. This is what the Monitor's Dead Code page consumes (vibecodeqa/app#7).
- **Added**: `knip.json` for the CLI's own self-analysis (scopes to `src/`, ignores fixtures).

## 0.48.0 (2026-07-24)

### New check: sqlite-d1 (advisory, component-gated)
- **Added**: audits SQLite/D1 data access and migration discipline. Injection findings are tiered by interpolation *position*, which is what makes them trustworthy: a **value** position (`= ${x}`, `'${x}'`, inside a string literal) is an error; a **table/column identifier** (`FROM ${x}`) and a spliced **SQL fragment** (`${scopeClause}`) are warnings ("safe if it comes from constants"); the canonical `IN (${placeholders})` idiom and SCREAMING_CASE constants are quiet. Also: `?` placeholders with no `.bind()` (statement-reuse and batch idioms recognised), queries inside loops (N+1 — excluding statements built *for* `batch()`), `SELECT *` (info), duplicate/unnumbered migration files, and `DROP TABLE` without `IF EXISTS`.
- **Scoring** is proportional to query volume, so a large well-written codebase is not punished for scale.

### Fixed — hidden directories are no longer scanned
- **Fixed**: the file walker recursed into hidden directories, so deploy mirrors and tooling copies (`.deploy/`, `.provision/`, `.claude/`) were scanned as if they were source. On a real project this **tripled** the file set and inflated every check — duplication, complexity, security, secrets. Hidden dirs are now skipped (files at the root are unaffected). This fix existed on an unmerged branch since 2026-07-22 and is now on main.

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
