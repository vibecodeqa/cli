# VibeCode QA

**Code health scanner for the AI coding era.**

One command. 34 checks. AI-powered fixes. Zero config.

```bash
npx @vibecodeqa/cli
```

![Grade](https://img.shields.io/badge/checks-34-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-first-3178C6) ![License](https://img.shields.io/badge/license-MIT-green) ![npm](https://img.shields.io/npm/v/@vibecodeqa/cli)

## What it does

vcqa scans your codebase and produces a scored health report with actionable findings. Auto-detects your stack (React, Vue, Svelte, Flutter, monorepos) and runs 34 checks across 7 categories.

**Scan → See issues → AI fixes them → Score improves.**

```bash
npx @vibecodeqa/cli                     # scan + full HTML report
npx @vibecodeqa/cli fix --ai            # AI-powered code fixes
npx @vibecodeqa/cli --skip-tests --top  # fast scan + top issues
```

## Install everywhere

```bash
# CLI (one command, no install needed)
npx @vibecodeqa/cli

# GitHub Action (automatic PR scanning)
- uses: vibecodeqa/action@v1
  with:
    fail-under: "70"

# VS Code Extension
ext install vibecodeqa

# MCP Server (for AI coding agents)
claude mcp add vcqa -- npx @vibecodeqa/mcp

# Programmatic API
import { scan } from "@vibecodeqa/cli/core";
const report = await scan("./src");
```

## AI-Powered Fix

Don't just find problems — fix them:

```bash
npx @vibecodeqa/cli fix --ai                      # fix all issues
npx @vibecodeqa/cli fix --ai --check security      # fix only security
npx @vibecodeqa/cli fix --ai --dry-run             # preview without applying
```

Uses Claude to read your code context, understand the issue, and generate a targeted fix. Requires `ANTHROPIC_API_KEY`.

## 34 Checks

### Foundations (23%)

| Check | Weight | What it measures |
|-------|--------|-----------------|
| Structure | 6% | Standard files, lockfile, test-to-source ratio |
| Lint | 5% | Biome or ESLint errors/warnings |
| Types | 6% | TypeScript compilation errors |
| Type Safety | 3% | `as any`, `@ts-ignore`, non-null assertions |
| Standards | 3% | File naming, large files, code smells |

### Quality (28%)

| Check | Weight | What it measures |
|-------|--------|-----------------|
| Complexity | 5% | Cognitive complexity per function |
| Duplication | 3% | Copy-pasted 6+ line blocks |
| Error Handling | 3% | Empty catch, throw string, floating promises |
| React Patterns | 3% | Conditional hooks, missing keys |
| Accessibility | 4% | img alt, click handlers, form labels |
| Docs | 3% | README quality, JSDoc coverage |
| Best Practices | 3% | CI/CD, supply chain, repo hygiene |
| HTML Quality | — | Static site: meta tags, broken links, heading hierarchy, render-blocking scripts |
| Frontend Health | 2% | UI framework conflicts, mixed icons, unoptimized images, heavy imports |
| Styling | 1% | Hardcoded colors, mixed approaches, !important, inconsistent spacing |
| Env Validation | 1% | .env hygiene, .env.example drift |
| Git Hygiene | 1% | Merge conflicts, commit quality, large/binary files |
| Memory Safety | 1% | Interval/listener leaks, unclosed observers, global pollution |

### Testing (13%)

Deep assessment: pyramid presence, execution, coverage, file pairing, quality metrics, E2E detection.

### Architecture (9%)

| Check | Weight | What it measures |
|-------|--------|-----------------|
| Architecture | 5% | Import graph, circular deps, god modules, orphans |
| Performance | 4% | Barrel imports, heavy deps, dynamic import opportunities |
| Container Health | — | Dockerfile best practices, .dockerignore, pinned images |

### Security (16%)

| Check | Weight | What it measures |
|-------|--------|-----------------|
| Secrets | 6% | Hardcoded keys (AWS, GitHub, Stripe, OpenAI, Anthropic) |
| Security | 5% | 31 CWE patterns (XSS, injection, SSRF, CORS) |
| Dependencies | 5% | npm audit CVEs, outdated packages |

### AI Readiness (9%)

| Check | Weight | What it measures |
|-------|--------|-----------------|
| Confusion Index | 4% | Naming ambiguity that confuses LLMs |
| Context Locality | 5% | Token density, import depth, circular deps |

### AI Analysis (PRO)

| Check | What it measures |
|-------|-----------------|
| Doc Coherence | Contradictions between docs and code |
| Code Coherence | Internal inconsistencies across modules |
| Comment Staleness | Stale TODOs, numeric mismatches, commented-out code |
| Dead Patterns | Leftover code from incomplete refactors |
| Test Audit | Fake/shallow tests that inflate coverage |
| File Cohesion | Files mixing multiple responsibilities |
| Design Consistency | Visual inconsistency across components |

## GitHub Action

```yaml
- uses: vibecodeqa/action@v1
  with:
    fail-under: "70"          # quality gate
    auto-fix: "true"          # AI fixes pushed to PR
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Features: PR comments, SARIF upload, quality gates, AI autofix.

## Programmatic API

```typescript
import { scan, CHECK_META } from "@vibecodeqa/cli/core";

const report = await scan("./src", {
  skipTests: true,
  checks: ["security", "testing"],
  onProgress: (check, result, i, total) => {
    console.log(`${i + 1}/${total} ${check}: ${result.grade}`);
  },
});

console.log(`${report.grade} ${report.score}/100`);
```

## MCP Server

Give AI coding agents real-time code health context:

```bash
claude mcp add vcqa -- npx @vibecodeqa/mcp
```

6 tools: `vcqa_score`, `vcqa_scan`, `vcqa_file_health`, `vcqa_check`, `vcqa_explain`, `vcqa_fix`.

## Configuration

Create `.vcqa.json`:

```json
{
  "checks": {
    "react": { "enabled": false },
    "container-health": { "ignore": ["Dockerfile.dev"] }
  },
  "ignore": ["generated/**", "vendor/**"],
  "failUnder": 70
}
```

## Monorepo support

Auto-detects: pnpm, npm, yarn, bun, lerna, turborepo, nx, melos.

## Stack detection

Auto-detects: TypeScript/JavaScript/Dart, React/Vue/Svelte/Flutter, Vite/Webpack/esbuild, vitest/jest, Biome/ESLint, pnpm/npm/yarn/bun.

## CLI options

| Flag | Description |
|------|-------------|
| `--skip-tests` | Skip test execution (fast mode) |
| `--ci` | CI mode (exit 1 if score < 60) |
| `--fail-under N` | Exit 1 if score < N |
| `--json` | JSON output |
| `--badge` | Generate SVG badge |
| `--sarif` | SARIF for GitHub Code Scanning |
| `--upload` | Upload to dashboard |
| `--top [N]` | Show top N issues |
| `--diff [base]` | Issues in changed files only |
| `--markdown` | Markdown summary |
| `--pr-comment` | PR comment (needs `GITHUB_TOKEN`) |
| `--annotations` | GitHub Actions annotations |
| `--watch` | Re-scan on file changes |

## Links

- **Website:** https://vibecodeqa.online
- **Dashboard:** https://app.vibecodeqa.online
- **GitHub Action:** https://github.com/vibecodeqa/action
- **VS Code:** https://github.com/vibecodeqa/vscode
- **MCP:** https://github.com/vibecodeqa/mcp

MIT — Free forever as a CLI tool.
