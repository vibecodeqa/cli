# VibeCode QA — TODO

## Done (v0.17.0)

- [x] 20 checks across 7 categories (18 active + 2 premium placeholders)
- [x] Auto-detect stack (TS/React/Vite/vitest/Biome/pnpm/npm/yarn/bun)
- [x] Self-contained HTML report — multi-page SPA with show/hide navigation
- [x] Primary nav (dimensions) + secondary nav (data views) + sidebar
- [x] Sub-tabs for checks within categories
- [x] Radar chart (6-axis category scores)
- [x] Score timeline chart (last 30 runs, grade-colored dots)
- [x] Testing pyramid SVG (proportional layer visualization)
- [x] Architecture SVG diagram (bezier edges, arrowheads, node health colors, legend)
- [x] File health page (merged heatmap + file map)
- [x] Bar chart (all checks ranked by score)
- [x] Category score cards on overview
- [x] Top issues preview + file hotspots on overview
- [x] Trend comparison vs previous run (score delta, new/fixed issues)
- [x] History persistence (.vibe-check/history/, keeps last 30)
- [x] Info panels with What/Risk/Fix for every check (with research citations)
- [x] Priority badges (critical/high/medium/low)
- [x] GitHub file links (auto-detected from git remote)
- [x] Actionable prompts (copy button generates fix prompt for Claude/Codex)
- [x] Issues grouped by file on detail pages
- [x] Watch mode (--watch, re-scans on file changes)
- [x] Monitor codebase heatmap (live watcher hits + git churn + issue counts)
- [x] --skip-tests, --ci, --json, --badge flags
- [x] Badge SVG generation (shields.io style)
- [x] Check metadata with weighted scoring (weights sum to 100)
- [x] 107 tests across 15 test files
- [x] Zero runtime dependencies
- [x] Published to npm as @vibecodeqa/cli
- [x] Error handling check (empty catch, throw string, Error Boundary)
- [x] React patterns check (conditional hooks, missing keys, index keys)
- [x] Accessibility check (img alt, click events, form labels, html lang)
- [x] Doc Coherence + Code Coherence premium placeholders
- [x] Confusion Index (novel — naming ambiguity for LLM comprehension)
- [x] Context Locality (novel — file self-containment for LLM consumption)

### Infrastructure
- [x] npm: @vibecodeqa/cli (published, auto-deploys on version bump)
- [x] GitHub org: vibecodeqa (3 repos: cli, vibecodeqa, app)
- [x] Landing page: vibecodeqa.online (CF Pages)
- [x] Dashboard app: app.vibecodeqa.online (React SPA, CF Pages)
- [x] Repo moved to vibecodeqa/cli

## Bugs to fix

### From review agents (2026-05-16)
- [x] 11 of 18 runners have their own file walking — migrate to fs-utils.ts
- [x] readDeps() defined in 3 places (fs-utils, testing, standards) — deduplicate
- [x] Complexity regex: `[?]:` malformed + `&&`/`||` can't match with `\b` boundaries
- [x] Context runner resolveImport: broken extension check (`endsWith("ts")` matches `myUtils`)
- [x] Duplication check over-reports for import blocks (normalize more aggressively)
- [x] Report clipboard API fails on file:// URLs (needs try/catch fallback)
- [x] Sidebar checks don't activate the correct sub-tab (calls go() but not sub())
- [x] Mobile: Issues/Files views inaccessible (hidden nav-views, sidebar also hidden)
- [x] Empty radar div takes space when <3 categories have scored checks
- [x] Content can overflow horizontally between 768-1100px viewport widths

### Older (partially addressed)
- [ ] Architecture SVG: >50 modules shows message instead of diagram — need clustering/zoom
- [x] Security check: "password in URL" pattern too broad — tightened to require 8+ char value
- [x] Security check: exec() regex too broad — matches regex.exec(), now scoped to child_process
- [x] Security check: flags own check-meta descriptions as vulnerabilities — skip string-only lines

## Next features — Free CLI

### High priority
- [ ] Interactive architecture graph (force-directed layout, draggable nodes)
- [x] Migrate all runners to fs-utils.ts (consistency + symlink/size protection)
- [x] Performance check (bundle analysis, barrel imports, tree-shaking issues)
- [x] SARIF output for GitHub Security tab integration

### Medium priority
- [ ] "Vibe Score" readability metric (nesting depth, naming quality, whitespace)
- [ ] Config drift detection (inconsistent tsconfig/biome across monorepo packages)
- [ ] Developer experience score (setup steps, .env.example, contributing guide)
- [ ] Coverage gauge cluster (4 arc charts for stmts/branches/lines/fns)
- [ ] PDF export
- [ ] Light theme option

### Low priority
- [ ] Sequence diagrams between modules
- [ ] Mobile-responsive sidebar (hamburger menu)
- [ ] Score benchmark comparison ("you're in the 85th percentile")
- [ ] Sunburst chart (category -> check -> file -> issues)

## Next features — PRO (hosted)

### GitHub App
- [ ] Install GitHub App → auto-scan on every PR
- [ ] PR comment with score delta and new issues
- [ ] Quality gate (block merge if score < threshold)

### AI Analysis (implement actual LLM checks)
- [ ] Doc Coherence: connect to Claude API, analyze README/JSDoc vs code
- [ ] Code Coherence: analyze cross-module patterns for contradictions
- [ ] AI-generated fix suggestions per issue
- [ ] Codebase summary generation (auto ARCHITECTURE.md)
- [ ] Custom rules via natural language

### Hosted dashboard
- [ ] GitHub OAuth integration for app.vibecodeqa.online
- [ ] Repo list with scores and grades
- [ ] Score trend charts (line chart, last 30 reports per repo)
- [ ] Team/org dashboard (aggregate scores across repos)
- [ ] Regression alerts ("repo X dropped 10 pts this week")
- [ ] Slack/Discord notifications
