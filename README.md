# VibeCode QA

**Code health scanner for the AI coding era.**

One command. 24 checks. Full report. Zero config.

```bash
npx @vibecodeqa/cli
```

![Grade](https://img.shields.io/badge/checks-24-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-first-3178C6) ![License](https://img.shields.io/badge/license-MIT-green)

## What it does

vcqa scans your TypeScript/JavaScript/Dart/Flutter codebase and produces a scored health report with actionable findings. It auto-detects your stack (React, Flutter, Vite, vitest, Biome, etc.) and runs 24 checks across 7 categories.

The output is a self-contained HTML report with radar charts, architecture diagrams, score timeline, testing pyramid, and drill-down issue lists — all navigable via sidebar and tab navigation.

## Quick start

```bash
# Scan current directory (runs tests + coverage)
npx @vibecodeqa/cli

# Fast mode (skip test execution)
npx @vibecodeqa/cli --skip-tests

# Watch mode (re-scan on file changes)
npx @vibecodeqa/cli --watch

# CI mode (exit code 1 if score < 60)
npx @vibecodeqa/cli --ci

# JSON output (pipe to other tools)
npx @vibecodeqa/cli --json

# Generate badge SVG for README
npx @vibecodeqa/cli --badge

# SARIF output for GitHub Security tab
npx @vibecodeqa/cli --sarif

# Scan a specific directory
npx @vibecodeqa/cli /path/to/project
```

Output goes to `.vibe-check/`:
- `report/index.html` — navigable multi-page dashboard (open in browser)
- `report.json` — machine-readable results
- `badge.svg` — shields.io-style badge (with `--badge`)
- `report.sarif` — SARIF 2.1.0 for GitHub Code Scanning (with `--sarif`)
- `history/` — last 30 reports for trend tracking

## Checks

### Foundations (23%)

| Check | Weight | What it measures |
|-------|--------|-----------------|
| **Structure** | 6% | Standard files (package.json, tsconfig, LICENSE, README, .gitignore), lockfile, test-to-source ratio |
| **Lint** | 5% | Biome or ESLint errors/warnings (auto-detected) |
| **Types** | 6% | TypeScript compilation errors (`tsc --noEmit`) |
| **Type Safety** | 3% | `as any`, `: any`, `@ts-ignore`, `@ts-nocheck` counts |
| **Standards** | 3% | File naming, large files (>300 lines), code smells (console.log, var, ==, eval), config hygiene |

### Quality (26%)

| Check | Weight | What it measures |
|-------|--------|-----------------|
| **Complexity** | 5% | Cognitive complexity per function, functions >60 lines |
| **Duplication** | 5% | Copy-pasted 6+ line blocks |
| **Error Handling** | 3% | Empty catch blocks, throw string, missing Error Boundaries, [error info leakage](https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html) (stack traces sent to client) |
| **React Patterns** | 3% | Conditional hooks, missing keys, index keys, prop spreading |
| **Accessibility** | 4% | img alt, click on non-interactive elements, form labels, html lang |
| **Docs** | 3% | README quality, JSDoc coverage of exports |
| **Best Practices** | 3% | CI/CD, lockfile, linter, test scripts, supply chain, [health endpoints](https://nodejs.org/learn/getting-started/security-best-practices), graceful shutdown, [Helmet.js](https://helmetjs.github.io/), input validation ([Zod](https://zod.dev)/Joi), [GitHub Actions security](https://docs.github.com/en/actions/security) (pwn requests, script injection, permissions). Severity-weighted: warnings=8pts, infos=2pts |

### Testing (15%)

One deep check with 6 sub-dimensions:

- **Pyramid presence** — unit, integration, component, E2E layers detected
- **Execution** — pass/fail from vitest/jest
- **Coverage** — statement, branch, line, function (v8/istanbul)
- **File pairing** — test file per source file
- **Quality** — assertion density, mock ratio, snapshot ratio
- **E2E detection** — Playwright/Cypress configured?

### Architecture (9%)

| Check | Weight | What it measures |
|-------|--------|-----------------|
| **Architecture** | 5% | Import graph, circular deps, god modules, orphan files, fan-out, SVG diagram with legend |
| **Performance** | 4% | Barrel imports, heavy dependencies, dynamic import opportunities, CSS-in-JS overhead |

### Security (16%)

| Check | Weight | What it measures |
|-------|--------|-----------------|
| **Secrets** | 6% | 14 patterns (AWS, GitHub, Stripe, OpenAI, Anthropic, Google, private keys) |
| **Security** | 5% | 36 CWE-mapped patterns (XSS, injection, SSRF, CORS, credential storage, cookies, redirects, debug mode). Delegates to [eslint-plugin-security](https://github.com/eslint-community/eslint-plugin-security) when installed |
| **Dependencies** | 5% | npm audit vulnerabilities, outdated packages, [license compliance](https://www.npmjs.com/package/license-checker) (GPL/AGPL/copyleft detection) |

### AI Readiness (11%)

Novel checks that no other tool offers:

| Check | Weight | What it measures |
|-------|--------|-----------------|
| **Confusion Index** | 6% | File name similarity, generic names, export collisions, ambiguous abbreviations |
| **Context Locality** | 5% | Token density, import depth, circular deps, context sinks |

### AI Analysis (PRO)

| Check | What it measures |
|-------|-----------------|
| **Doc Coherence** | LLM-powered detection of contradictions between docs and code (JSDoc mismatch, stale README refs) |
| **Code Coherence** | LLM-powered detection of internal inconsistencies (mixed error patterns, duplicate exports) |
| **Comment Staleness** | Stale TODOs (>6 months), numeric mismatches ("3 cases" but 5 exist), commented-out code blocks, @deprecated without replacement |

## Scoring

Each check produces a score from 0-100. The composite score is a **weighted average**:

```
composite = Σ(check_score × weight) / Σ(weight)
```

Weights sum to 100% (see table above). Skipped checks are excluded from both numerator and denominator. Within each check, scoring is **proportional to codebase size** — no absolute-count cliffs. The `best-practices` check uses **severity-weighted penalties** (error=15pts, warning=8pts, info=2pts) so missing nice-to-haves like CODEOWNERS don't tank your score.

| Grade | Score | Meaning |
|-------|-------|---------|
| **A** | 90-100 | Excellent — production-ready |
| **B** | 75-89 | Good — minor issues |
| **C** | 60-74 | Fair — needs attention |
| **D** | 40-59 | Poor — significant issues |
| **F** | 0-39 | Critical — major problems |

## Report features

- **Primary nav**: Overview + 7 dimension tabs (Foundations, Quality, Testing, Architecture, Security, AI Readiness, AI Analysis)
- **Secondary nav**: Issues + Files (cross-cutting data views)
- **Score ring + radar chart** — 6-axis view of category scores
- **Score timeline** — last 30 runs with grade-colored dots
- **Testing pyramid** — proportional SVG showing unit/integration/component/e2e distribution
- **Architecture SVG** — modules grouped by directory, bezier edges with arrows, color-coded nodes (god module, cycle, orphan), legend
- **File health map** — heatmap bars showing issue density per file
- **Trend comparison** — score delta vs. previous run
- **GitHub links** — click any file:line to open in GitHub (auto-detected from git remote)
- **Actionable prompts** — clipboard button on every issue copies a fix prompt for Claude/Codex
- **Info panels** — each check has What/Risk/Fix explanations with research citations
- **Priority badges** — critical/high/medium/low on each check

## CLI options

| Flag | Description |
|------|-------------|
| `--skip-tests` | Skip test execution and coverage (fast mode) |
| `--ci` | Exit code 1 if composite score < 60 |
| `--fail-under N` | Exit code 1 if composite score < N |
| `--json` | Output JSON to stdout (no HTML, no browser) |
| `--badge` | Generate badge.svg in output directory |
| `--sarif` | Generate SARIF 2.1.0 for GitHub Code Scanning |
| `--upload` | Upload report to app.vibecodeqa.online |
| `--top [N]` | Show top N issues to fix (default: 5) |
| `--diff [base]` | Only show issues in changed files (vs HEAD or branch) |
| `--markdown` | Output markdown summary (pipe to file or clipboard) |
| `--pr-comment` | Post score as GitHub PR comment (needs `GITHUB_TOKEN`) |
| `--annotations` | Emit GitHub Actions `::warning`/`::error` inline annotations |
| `--watch` | Re-scan automatically on file changes |

## Stack detection

Auto-detects from `package.json`, `pubspec.yaml`, and config files:
- **Language:** TypeScript, JavaScript, Dart
- **Framework:** React, Vue, Svelte, Flutter
- **Bundler:** Vite, Webpack, esbuild
- **Test runner:** vitest, jest, flutter_test, dart_test
- **Linter:** Biome, ESLint, dart analyze
- **Package manager:** pnpm, npm, yarn, bun, pub

## Configuration

Create `.vcqa.json` in your project root (or add a `"vcqa"` field to `package.json`):

```json
{
  "checks": {
    "confusion": { "enabled": false },
    "react": { "enabled": false }
  },
  "ignore": ["generated/**", "*.pb.ts", "vendor/**"],
  "failUnder": 70
}
```

| Field | Description |
|-------|-------------|
| `checks` | Disable individual checks with `"enabled": false` |
| `ignore` | Extra glob patterns to skip when scanning source files |
| `failUnder` | Default score threshold (overridden by `--fail-under` flag) |

## Monorepo support

Automatically detects and scans all packages in:
- **pnpm** — `pnpm-workspace.yaml` (with comments, flow-style YAML, negation patterns)
- **npm/yarn** — `workspaces` in `package.json`
- **bun** — `workspaces` in `package.json` + `bun.lockb`
- **lerna** — `lerna.json`
- **turborepo** — `turbo.json` (overlay on pnpm/npm/yarn)
- **nx** — `nx.json` (overlay on pnpm/npm/yarn)
- **melos** — `melos.yaml` (Dart/Flutter monorepos)
- **Conventional layouts** — `server/` + `client/`, `apps/` + `packages/`, etc.

Framework detection aggregates deps from all workspace packages — React in `packages/web/package.json` is detected even if root has no React dependency.

## GitHub Actions

Add this to `.github/workflows/vibecodeqa.yml` for automatic PR scanning:

```yaml
name: VibeCode QA
on: [pull_request]
permissions:
  contents: read
  pull-requests: write
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx @vibecodeqa/cli --skip-tests --ci --sarif --pr-comment
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: .vibe-check/report.sarif
```

## License

MIT — Free forever as a CLI tool.

## Links

- **GitHub:** https://github.com/vibecodeqa/cli
- **Website:** https://vibecodeqa.online
- **npm:** https://www.npmjs.com/package/@vibecodeqa/cli
- **Issues:** https://github.com/vibecodeqa/cli/issues
