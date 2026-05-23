# VibeCode QA — CLI

Code health scanner for the AI coding era. Zero runtime deps, pure TypeScript.

## Quick reference

```bash
pnpm install        # install dev deps
pnpm build          # tsc → dist/
pnpm test           # vitest run (271 tests across 30 files)
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
├── check-meta.ts       # Metadata for all 22 checks (weight, description, deeperTools)
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
│   ├── duplication.ts  # Delegates to jscpd (opt-in), falls back to line-hash
│   ├── docs.ts         # README quality, JSDoc coverage, CHANGELOG
│   ├── best-practices.ts  # CI/CD, supply chain, repo hygiene
│   ├── testing.ts      # Pyramid, execution, coverage (.ts/.dart aware)
│   ├── secrets.ts      # Delegates to gitleaks, falls back to 14 regex + .env audit
│   ├── security.ts     # 25 CWE patterns + localStorage audit + v-html/\{@html\}
│   ├── dependencies.ts # npm audit / dart pub outdated
│   ├── architecture.ts # Import graph, cycles, god modules (Vue/Svelte import resolution)
│   ├── confusion.ts    # Naming ambiguity (Levenshtein, cross-package aware)
│   ├── context.ts      # Token density, import depth, circular dep impact
│   ├── performance.ts  # Barrel imports, heavy deps, dead code (Knip)
│   ├── doc-coherence.ts   # Pro: JSDoc mismatch + README stale refs
│   ├── code-coherence.ts  # Pro: mixed error patterns, duplicate exports
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

## 22 Checks across 7 categories

Weights sum to 100 (Pro checks have weight 0).

| Category | Checks | Weights |
|---|---|---|
| **Foundations** | structure, lint, types, type-safety, standards | 6+5+6+3+3 = 23 |
| **Quality** | complexity, duplication, error-handling, react, accessibility, docs, best-practices | 5+5+3+3+4+3+3 = 26 |
| **Testing** | testing | 15 |
| **Architecture** | architecture, performance | 5+4 = 9 |
| **Security** | secrets, security, dependencies | 6+5+5 = 16 |
| **AI Readiness** | confusion, context | 6+5 = 11 |
| **AI Analysis** | doc-coherence, code-coherence | 0+0 (PRO) |

## Supported stacks

- **TypeScript/JavaScript** — React, Vue (.vue SFC), Svelte (.svelte SFC), Next.js, Nuxt, SvelteKit
- **Dart/Flutter** — dart analyze, flutter_test, melos workspaces, _test.dart convention
- **Monorepos** — pnpm, npm, yarn workspaces, lerna, turborepo, nx, melos

## Tool delegation

Tries dedicated tools first, falls back to built-in:
- **Secrets**: gitleaks → 14 regex patterns
- **Duplication**: jscpd (if in devDeps) → line-hash
- **Dead code**: Knip (if available)
- **React hooks**: eslint-plugin-react-hooks (if installed, skips built-in)
- **Accessibility**: eslint-plugin-jsx-a11y (if installed, skips built-in)

## CLI commands

- `vcqa [path]` — scan and generate report
- `vcqa init [path]` — create CI workflow + biome.json + .gitignore
- `vcqa fix [path]` — auto-fix (biome/eslint) + 30+ fix suggestions

## Flags

`--skip-tests`, `--ci`, `--fail-under N`, `--json`, `--badge`, `--sarif`, `--upload`, `--top [N]`, `--diff [base]`, `--watch`, `-v`, `-h`

## Testing

```bash
pnpm test                    # 271 tests across 30 files
pnpm test -- --reporter=verbose  # see all test names
```

Test files: `*.test.ts` in src/ and src/runners/. CLI integration tests in `cli.test.ts`.
