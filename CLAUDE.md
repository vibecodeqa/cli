# VibeCode QA — CLI

Code health scanner for the AI coding era. Pure TypeScript, lean runtime deps:
ink/react (the `monitor` TUI) and @jscpd/core (duplication engine, ~100 KB).

## Quick reference

```bash
pnpm install        # install dev deps
pnpm build          # tsc → dist/
pnpm test           # vitest run (360 tests across 35 files)
pnpm lint           # biome check src/
node dist/cli.js    # self-scan
node dist/cli.js init               # set up CI workflow + configs
node dist/cli.js fix                # auto-fix + suggestions
node dist/cli.js --skip-tests --top # fast scan + top issues
node dist/cli.js --help             # show all flags
```

## Architecture

```
src/
├── cli.ts              # Entry: flags, init/fix commands, runner orchestration
├── types.ts            # CheckResult, Issue, VibeReport, StackInfo, WorkspaceInfo
├── score.ts            # Weighted composite score from check-meta weights
├── check-meta.ts       # Metadata for all 25 checks (weight, description, deeperTools)
├── detect.ts           # Auto-detect stack + workspace (monorepo, melos, turborepo, nx)
├── fs-utils.ts         # File walker (symlink-safe, SFC extraction, global srcRoots)
├── trend.ts            # Trend comparison + terminal sparkline
├── history.ts          # Read .vibe-check/history/ for timeline data
├── runners/            # One file per check
│   ├── structure.ts    # Project files, lockfile, test ratio, monorepo-aware
│   ├── lint.ts         # Runs biome/eslint/dart analyze, monorepo-aware
│   ├── types-check.ts  # Runs tsc --noEmit (per-package for monorepos)
│   ├── type-safety.ts  # as any, @ts-ignore, dynamic (Dart)
│   ├── standards.ts    # Code smells, naming, large files
│   ├── error-handling.ts  # Empty catch, floating promises, JSON.parse, infinite loops
│   ├── react.ts        # Hooks rules, missing keys (skips when eslint plugin installed)
│   ├── accessibility.ts   # img alt, click handlers, v-for key (Vue/Svelte SFC aware)
│   ├── complexity.ts   # Cognitive complexity per function
│   ├── duplication.ts  # jscpd CLI (opt-in) → @jscpd/core engine over our own tokenizer (maximal clones)
│   ├── docs.ts         # README quality, JSDoc coverage, CHANGELOG
│   ├── best-practices.ts  # CI/CD, supply chain, repo hygiene
│   ├── testing.ts      # Pyramid, execution, coverage (.ts/.dart aware)
│   ├── secrets.ts      # Delegates to gitleaks, falls back to 14 regex + .env audit
│   ├── security.ts     # 36 CWE patterns + data storage audit + eslint-plugin-security delegation
│   ├── dependencies.ts # npm audit / dart pub outdated
│   ├── architecture.ts # Import graph, cycles, god modules — dependency-cruiser engine (TS/JS), built-in resolver for SFC/monorepo
│   ├── confusion.ts    # Naming ambiguity (Levenshtein, cross-package aware)
│   ├── context.ts      # Token density, import depth, circular dep impact
│   ├── performance.ts  # Barrel imports, heavy deps, dead code (Knip)
│   ├── doc-coherence.ts   # Pro: JSDoc mismatch + README stale refs
│   ├── code-coherence.ts  # Pro: mixed error patterns, duplicate exports
│   ├── comment-staleness.ts # Pro: stale TODOs, numeric mismatches, commented-out code
│   ├── dead-patterns.ts  # Pro: refactor debt, fallbacks, parallel impls (LLM-powered)
│   ├── test-audit.ts    # Pro: fake/shallow tests, trivial assertions, mock abuse
│   └── exec.ts         # Shared execSync wrapper
├── diagrams/           # Architecture SVG generators (interactive)
│   ├── index.ts        # Barrel re-export
│   ├── graph.ts        # Dependency graph (click-to-highlight) + DSM matrix
│   └── layers.ts       # Package, sequence, layer, container diagrams
└── report/             # Multi-page HTML report
    ├── html.ts         # Assembles nav, sidebar, pages
    ├── pages.ts        # Page renderers (overview, categories, issues, files, trends)
    ├── svg.ts          # SVG builders (ring, radar, timeline, pyramid, badge, sparkline)
    ├── sarif.ts        # SARIF 2.1.0 output for GitHub Code Scanning
    ├── styles.ts       # All CSS
    └── components.ts   # HTML escape, file links, grade/priority colors
```

## 25 Checks across 7 categories

Weights sum to 100 (Pro checks have weight 0).

| Category | Checks | Weights |
|---|---|---|
| **Foundations** | structure, lint, types, type-safety, standards | 6+5+6+3+3 = 23 |
| **Quality** | complexity, duplication, error-handling, react, accessibility, docs, best-practices | 5+5+3+3+4+3+3 = 26 |
| **Testing** | testing | 15 |
| **Architecture** | architecture, performance | 5+4 = 9 |
| **Security** | secrets, security, dependencies | 6+5+5 = 16 |
| **AI Readiness** | confusion, context | 6+5 = 11 |
| **AI Analysis** | doc-coherence, code-coherence, comment-staleness, dead-patterns, test-audit | 0+0+0+0+0 (PRO) |

## Supported stacks

- **TypeScript/JavaScript** — React, Vue (.vue SFC), Svelte (.svelte SFC), Next.js, Nuxt, SvelteKit
- **Dart/Flutter** — dart analyze, flutter_test, melos workspaces, _test.dart convention
- **Monorepos** — pnpm, npm, yarn workspaces, lerna, turborepo, nx, melos

## Tool delegation

Tries dedicated tools first, falls back to built-in:
- **Secrets**: gitleaks → 14 regex patterns
- **Duplication**: jscpd CLI (if in devDeps) → @jscpd/core's Rabin-Karp engine fed by our lightweight tokenizer (Type-1/2 maximal clones, 50 tokens/6 lines). Our tokenizer keeps the heavy @jscpd/tokenizer (2.5MB language grammars) out of the install.
- **Dead code**: Knip (if available)
- **React hooks**: eslint-plugin-react-hooks (if installed, skips built-in)
- **Accessibility**: eslint-plugin-jsx-a11y (if installed, skips built-in)

## CLI commands

- `vcqa [path]` — scan and generate report. In an interactive terminal it also shows
  the top issues, a "weakest areas → `vcqa explain <check>`" footer, and a post-scan
  prompt (`[m]` monitor · `[o]` open report · `enter` quit). Piped/CI runs stay quiet.
- `vcqa init [path]` — create CI workflow + biome.json + .gitignore
- `vcqa fix [path]` — auto-fix (biome/eslint) + 30+ fix suggestions
- `vcqa explain [check]` — deep-dive what/risk/fix for a check
- `vcqa monitor [path]` — live TUI (re-scans on change). Keys: ↑↓/Enter/Esc navigate,
  `/` search issues, `y` copy fix-prompt, `r` scan, `f`/`g`/`t`/`c` views, `?` help, `q` quit

## Flags

`--skip-tests`, `--ci`, `--fail-under N`, `--json`, `--badge`, `--sarif`, `--upload`, `--top [N]`, `--diff [base]`, `--watch`, `-v`, `-h`

## Testing

```bash
pnpm test                    # 360 tests across 35 files
pnpm test -- --reporter=verbose  # see all test names
```

Test files: `*.test.ts` in src/ and src/runners/. CLI integration tests in `cli.test.ts`.
