# VibeCode QA

**Code health scanner for the AI coding era.**

One command. 20 checks. Full report. Zero config.

```bash
npx @vibecodeqa/cli
```

![Grade](https://img.shields.io/badge/checks-20-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-first-3178C6) ![License](https://img.shields.io/badge/license-MIT-green)

## What it does

vcqa scans your TypeScript/JavaScript codebase and produces a scored health report with actionable findings. It auto-detects your stack (React, Vite, vitest, Biome, etc.) and runs 20 checks across 7 categories.

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

# Scan a specific directory
npx @vibecodeqa/cli /path/to/project
```

Output goes to `.vibe-check/`:
- `report.html` — navigable multi-page dashboard (open in browser)
- `report.json` — machine-readable results
- `badge.svg` — shields.io-style badge (with `--badge`)
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

### Quality (23%)

| Check | Weight | What it measures |
|-------|--------|-----------------|
| **Complexity** | 5% | Cognitive complexity per function, functions >60 lines |
| **Duplication** | 5% | Copy-pasted 6+ line blocks |
| **Error Handling** | 3% | Empty catch blocks, throw string, missing Error Boundaries |
| **React Patterns** | 3% | Conditional hooks, missing keys, index keys, prop spreading |
| **Accessibility** | 4% | img alt, click on non-interactive elements, form labels, html lang |
| **Docs** | 3% | README quality, JSDoc coverage of exports |

### Testing (17%)

One deep check with 6 sub-dimensions:

- **Pyramid presence** — unit, integration, component, E2E layers detected
- **Execution** — pass/fail from vitest/jest
- **Coverage** — statement, branch, line, function (v8/istanbul)
- **File pairing** — test file per source file
- **Quality** — assertion density, mock ratio, snapshot ratio
- **E2E detection** — Playwright/Cypress configured?

### Architecture (6%)

| Check | Weight | What it measures |
|-------|--------|-----------------|
| **Architecture** | 6% | Import graph, circular deps, god modules, orphan files, fan-out, SVG diagram with legend |

### Security (18%)

| Check | Weight | What it measures |
|-------|--------|-----------------|
| **Secrets** | 6% | 13 patterns (AWS, GitHub, Stripe, OpenAI, private keys) |
| **Security** | 7% | 15 CWE-mapped patterns (XSS, injection, crypto, SSRF) |
| **Dependencies** | 5% | npm audit vulnerabilities + outdated packages |

### AI Readiness (13%)

Novel checks that no other tool offers:

| Check | Weight | What it measures |
|-------|--------|-----------------|
| **Confusion Index** | 7% | File name similarity, generic names, export collisions, ambiguous abbreviations |
| **Context Locality** | 6% | Token density, import depth, circular deps, context sinks |

### AI Analysis (PRO — coming soon)

| Check | What it will do |
|-------|----------------|
| **Doc Coherence** | LLM-powered detection of contradictions between docs and code |
| **Code Coherence** | LLM-powered detection of internal inconsistencies across modules |

## Scoring

Each check produces a score from 0-100. The composite score is a weighted average (weights shown above, sum to 100%). Grades:

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
| `--watch` | Re-scan automatically on file changes |
| `--ci` | Exit code 1 if composite score < 60 |
| `--json` | Output JSON to stdout (no HTML, no browser) |
| `--badge` | Generate badge.svg in output directory |

## Stack detection

Auto-detects from `package.json` and config files:
- **Language:** TypeScript, JavaScript
- **Framework:** React, Vue, Svelte
- **Bundler:** Vite, Webpack, esbuild
- **Test runner:** vitest, jest
- **Linter:** Biome, ESLint
- **Package manager:** pnpm, npm, yarn, bun

## License

MIT — Free forever as a CLI tool.

## Links

- **GitHub:** https://github.com/vibecodeqa/cli
- **Website:** https://vibecodeqa.online
- **npm:** https://www.npmjs.com/package/@vibecodeqa/cli
- **Issues:** https://github.com/vibecodeqa/cli/issues
