# VibeCode QA — CLI

Code health scanner for the AI coding era. Pure TypeScript, lean runtime deps:
ink/react (the `monitor` TUI) and @jscpd/core (duplication engine, ~100 KB).

## Quick reference

```bash
pnpm install        # install dev deps
pnpm build          # tsc → dist/
pnpm test           # vitest run (440+ tests across 43 files)
pnpm lint           # biome check src/
node dist/cli.js    # self-scan
node dist/cli.js init               # set up CI workflow + configs
node dist/cli.js fix                # auto-fix + suggestions
node dist/cli.js fix --ai           # AI-powered fix (uses Claude)
node dist/cli.js --skip-tests --top # fast scan + top issues
node dist/cli.js --help             # show all flags
```

## Releasing — CI only, never local

**Never run `npm publish` locally.** Publishing is fully automated by
`.github/workflows/publish.yml` and is the *only* sanctioned path to npm — it
uses OIDC trusted publishing with `--provenance`, which a local publish cannot
reproduce (and which local publishes would undermine).

To cut a release:

1. Land the code fix on `main` (via PR or push).
2. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
3. Push to `main`.

The workflow triggers on pushes touching `src/**`, `package.json`, or the
workflow file. It builds, runs the full test suite, then compares the local
`package.json` version against the published npm version — **it publishes only
when they differ.** So a code change without a version bump will NOT ship
(this is the trap that stranded the `pruneNestedRoots` fix in 0.44.0: the code
was committed but the version was never bumped, so CI kept skipping publish).

Verify a release with `gh run list` and `npm view @vibecodeqa/cli version`.
`workflow_dispatch` is available to re-run manually.

## Architecture

```
src/
├── cli.ts              # Entry: flags, init/fix commands, runner orchestration
├── core.ts             # Programmatic API: import { scan } from "@vibecodeqa/cli/core"
├── ai-fix.ts           # AI-powered code fixing (Claude API, search/replace)
├── delta.ts            # Delta report: computeDelta(before, after), formatDeltaMarkdown
├── types.ts            # CheckResult, Issue, VibeReport, StackInfo, WorkspaceInfo
├── score.ts            # Weighted composite score from check-meta weights
├── check-meta.ts       # Re-export shim → @vibecodeqa/schema (weight, description, appliesTo)
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
│   ├── react.ts        # Hooks rules, missing keys, Error Boundary, Tailwind inline styles
│   ├── accessibility.ts   # img alt, click handlers, v-for key (Vue/Svelte SFC aware)
│   ├── complexity.ts   # Cognitive complexity per function
│   ├── duplication.ts  # jscpd CLI (opt-in) → @jscpd/core engine over our own tokenizer (maximal clones)
│   ├── docs.ts         # README quality, JSDoc coverage, CHANGELOG
│   ├── best-practices.ts  # CI/CD, supply chain, repo hygiene
│   ├── testing.ts      # Pyramid, execution, coverage (.ts/.dart aware)
│   ├── secrets.ts      # Delegates to gitleaks; fallback = our patterns (LLM keys) ∪ secretlint preset + .env audit
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

## Stack gating rule (enforced in review)

A check is either **stack-gated** (declares `appliesTo` in its CheckMeta — language
and/or framework lists; the scan core in `core.ts` skips it centrally with a standard
"not applicable" result) or **stack-blind** (never mentions a framework). A
`stack.framework === ...` branch inside a generic runner is a rejected diff — move the
logic into the framework's own check (see `react.ts`) or gate the whole check.
Stack-*adaptive* behavior driven by detection (e.g. `structure` requiring `pubspec.yaml`
vs `package.json` by language) is fine; framework special-casing is not.

## 34 Checks across 7 categories

Weights sum to 100 (Pro checks have weight 0).

| Category | Checks | Weights |
|---|---|---|
| **Foundations** | structure, lint, types, type-safety, standards | 6+5+6+3+3 = 23 |
| **Quality** | complexity, duplication, error-handling, react, accessibility, docs, best-practices, frontend-health, env-validation, git-hygiene, memory-safety, styling, html-quality, container-health | 5+3+3+3+4+3+3+2+1+1+1+1+0+0 = 30 |
| **Testing** | testing | 13 |
| **Architecture** | architecture, performance | 5+4 = 9 |
| **Security** | secrets, security, dependencies | 6+5+5 = 16 |
| **AI Readiness** | confusion, context | 4+5 = 9 |
| **AI Analysis** | doc-coherence, code-coherence, comment-staleness, dead-patterns, test-audit, file-cohesion, design-consistency | all 0 (PRO) |

Do not hand-edit weights here without checking `@vibecodeqa/schema`'s `CHECK_META` — the schema package is the source of truth; this table is a convenience copy.

## Supported stacks

- **TypeScript/JavaScript** — React, Vue (.vue SFC), Svelte (.svelte SFC), Next.js, Nuxt, SvelteKit
- **Dart/Flutter** — dart analyze, flutter_test, melos workspaces, _test.dart convention
- **Monorepos** — pnpm, npm, yarn workspaces, lerna, turborepo, nx, melos

## Tool delegation

Tries dedicated tools first, falls back to built-in:
- **Secrets**: gitleaks → built-in patterns (14, incl. OpenAI/Anthropic) ∪ secretlint recommended preset
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
  - `--ai` — use Claude to fix remaining issues (needs ANTHROPIC_API_KEY or VCQA_PRO_KEY)
  - `--check NAME` — only fix issues from a specific check
  - `--dry-run` — preview fixes without applying
- `vcqa explain [check]` — deep-dive what/risk/fix for a check
- `vcqa monitor [path]` — live TUI (re-scans on change). Keys: ↑↓/Enter/Esc navigate,
  `/` search issues, `y` copy fix-prompt, `r` scan, `f`/`g`/`t`/`c` views, `?` help, `q` quit

## Flags

`--skip-tests`, `--ci`, `--fail-under N`, `--json`, `--badge`, `--sarif`, `--upload`, `--top [N]`, `--diff [base]`, `--watch`, `-v`, `-h`

## Testing

```bash
pnpm test                    # 440+ tests across 43 files
pnpm test -- --reporter=verbose  # see all test names
```

Test files: `*.test.ts` in src/ and src/runners/. CLI integration tests in `cli.test.ts`.

## Programmatic API

```typescript
import { scan, CHECK_META, type VibeReport } from "@vibecodeqa/cli/core";

const report = await scan("./src", {
  skipTests: true,
  checks: ["security", "testing"],
  onProgress: (check, result, i, total) => console.log(`${i+1}/${total} ${check}`),
});
```

Exports: `scan`, `CHECK_META`, `getCheckMeta`, `computeScore`, `detectStack`, `detectWorkspace`, `loadConfig`, `gradeFromScore`, and all types.
