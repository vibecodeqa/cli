# VibeCode QA — CLI

Code health scanner for the AI coding era. Zero runtime deps, pure TypeScript.

## Quick reference

```bash
pnpm install        # install dev deps
pnpm build          # tsc → dist/
pnpm test           # vitest run (107 tests)
pnpm lint           # biome check src/
node dist/cli.js    # self-scan
node dist/cli.js --skip-tests --badge  # fast scan + badge SVG
```

## Architecture

```
src/
├── cli.ts              # Entry point — flag parsing, runner orchestration, output
├── types.ts            # CheckResult, Issue, VibeReport, StackInfo, gradeFromScore
├── score.ts            # Weighted composite score from check-meta weights
├── check-meta.ts       # Metadata for all 20 checks (name, label, category, weight, description, risk, recommendation)
├── detect.ts           # Auto-detect stack (TS/React/Vite/vitest/Biome/pnpm) + git remote
├── fs-utils.ts         # Shared file walker (symlink protection, 1MB limit, skip dirs)
├── trend.ts            # Compare current report to previous, compute deltas
├── history.ts          # Read .vibe-check/history/ for timeline data
├── runners/            # One file per check — each exports a run function returning CheckResult
│   ├── structure.ts    # Project files, lockfile, test ratio
│   ├── lint.ts         # Runs biome/eslint, parses output
│   ├── types-check.ts  # Runs tsc --noEmit
│   ├── type-safety.ts  # Counts as any, @ts-ignore, etc.
│   ├── standards.ts    # Code smells, naming, large files
│   ├── error-handling.ts  # Empty catch, throw string, Error Boundary
│   ├── react.ts        # Conditional hooks, missing keys, index keys
│   ├── accessibility.ts   # img alt, click on div, form labels, html lang
│   ├── complexity.ts   # Cognitive complexity per function
│   ├── duplication.ts  # Copy-pasted 6+ line blocks
│   ├── docs.ts         # README quality, JSDoc coverage
│   ├── testing.ts      # Deep test assessment (pyramid, coverage, quality)
│   ├── secrets.ts      # Hardcoded API keys, tokens (13 patterns)
│   ├── security.ts     # 15 CWE-mapped vulnerability patterns
│   ├── dependencies.ts # npm audit + outdated packages
│   ├── architecture.ts # Import graph, cycles, god modules, SVG diagram
│   ├── confusion.ts    # Naming ambiguity (Levenshtein, synonyms, collisions)
│   ├── context.ts      # Token density, import depth, context sinks
│   ├── doc-coherence.ts   # PREMIUM placeholder — docs vs code contradictions
│   ├── code-coherence.ts  # PREMIUM placeholder — internal codebase contradictions
│   └── exec.ts         # Shared execSync wrapper
└── report/             # HTML report generation (self-contained single file)
    ├── html.ts         # Main generator — assembles nav, sidebar, pages
    ├── pages.ts        # Page renderers (overview, categories, issues, files)
    ├── svg.ts          # SVG builders (ring, radar, timeline, pyramid, badge, sparkline)
    ├── styles.ts       # All CSS as a template string
    └── components.ts   # Helpers (HTML escape, file links, grade/priority colors)
```

## 20 Checks across 7 categories

Weights sum to 100 (premium checks have weight 0).

| Category | Checks | Weights |
|---|---|---|
| **Foundations** | structure, lint, types, type-safety, standards | 6+5+6+3+3 = 23 |
| **Quality** | complexity, duplication, error-handling, react, accessibility, docs | 5+5+3+3+4+3 = 23 |
| **Testing** | testing | 17 |
| **Architecture** | architecture | 6 |
| **Security** | secrets, security, dependencies | 6+7+5 = 18 |
| **AI Readiness** | confusion, context | 7+6 = 13 |
| **AI Analysis** | doc-coherence, code-coherence | 0+0 (PRO) |

## Report structure

- **Primary nav (left):** Overview + 7 dimension tabs
- **Secondary nav (right):** Issues + Files (data views)
- **Overview:** score ring, radar chart, category cards, score timeline, bar chart, top issues preview, file hotspots
- **Dimension pages:** sub-tabs per check, info panels (What/Risk/Fix), issues grouped by file
- **AI Analysis:** premium cards with gradient styling, "coming soon" state

## Key patterns

- Every runner returns `CheckResult` — synchronous, no async
- Runners that call external tools (lint, types, testing, dependencies) use `exec.ts`
- `fs-utils.ts` is the canonical file walker — 4 runners use it, 11 still have their own (migration needed)
- Premium checks return `{ details: { comingSoon: true, premium: true } }` — excluded from score
- Skipped checks return `{ details: { skipped: true, reason: "..." } }` — excluded from score
- Report is one self-contained HTML file — no external deps, no JS frameworks

## Known issues from review agents

- 11 of 18 runners duplicate file walking instead of using fs-utils.ts
- `readDeps()` defined in 3 places (fs-utils, testing, standards)
- Complexity regex has malformed ternary/&&/|| matching
- Context runner's resolveImport has broken extension check
- Duplication check over-reports for import blocks
- Clipboard API in report fails on file:// URLs (no fallback)
- Sidebar checks don't activate the correct sub-tab
- Mobile: Issues/Files views inaccessible (hidden with no alternative)

## npm publish

Auto-publishes via `.github/workflows/publish.yml` on push to main when version changes.
Requires `NPM_TOKEN` secret on the repo (needs to be set — not yet configured).

## Testing

```bash
pnpm test                    # 107 tests across 15 files
pnpm test -- --reporter=verbose  # see all test names
```

Test files mirror source files: `foo.ts` → `foo.test.ts`. Tests use temp directories (`mkdtempSync`) and clean up after themselves.
