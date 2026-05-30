# Competitive Landscape — Code Quality Tools

How VibeCode QA compares to existing tools. Updated 2026-05-18.

**Public transparency page:** https://vibecodeqa.online/tools.html

## What We Check vs. Dedicated Tools

| Check | VibeCode QA | Dedicated Tool | Their Advantage |
|-------|-------------|----------------|-----------------|
| **Lint** | Delegates to biome/eslint | biome, eslint | We run theirs — no overlap |
| **Type Check** | Delegates to tsc | TypeScript compiler | We run theirs — no overlap |
| **Test Execution** | Delegates to vitest/jest | vitest, jest | We run theirs — no overlap |
| **Dependency Audit** | Delegates to npm audit | npm audit, snyk, socket.dev | Snyk has deeper vuln DB + fix PRs |
| **Type Safety** | Regex (as any, @ts-ignore) | @typescript-eslint | They have AST + type info, catch more |
| **Error Handling** | Regex (empty catch, floating promises) | @typescript-eslint/no-floating-promises | They use type-aware analysis |
| **React Patterns** | Regex (conditional hooks, missing keys) | eslint-plugin-react-hooks | They use AST, authoritative for hooks rules |
| **Accessibility** | Regex (alt, labels, tabindex) | eslint-plugin-jsx-a11y, axe-core | axe-core tests at runtime in browser |
| **Security** | 19 regex patterns (CWE-mapped) | semgrep, CodeQL, eslint-plugin-security | They do data flow analysis, catch taint paths |
| **Secrets** | 13 regex patterns | gitleaks, trufflehog | They scan git history, have 800+ patterns |
| **Complexity** | Heuristic per-function | biome, SonarQube | SonarQube is the industry standard |
| **Duplication** | Line-hash 6-line blocks | jscpd, SonarQube, semgrep Pro | jscpd uses AST tokens, better accuracy |
| **Code Standards** | Regex (console.log, var, ==) | biome, eslint | Fully covered by linters already |

## What Nobody Else Does (Our Moat)

| Check | What It Does | Closest Alternative |
|-------|-------------|---------------------|
| **Architecture Analysis** | Import graph, cycles, god modules, 6 SVG diagrams (dep graph, DSM, sequence, layer, package, container) with interactive click/hover | Madge (graph only), NDepend (.NET only), SonarQube (some metrics) |
| **AI Readiness — Confusion** | Levenshtein filename similarity, synonym detection, export collisions, generic naming | Nothing — unique to VibeCode QA |
| **AI Readiness — Context** | Token density per file, import depth, circular dep impact on LLM context windows | Nothing — unique to VibeCode QA |
| **Monorepo Understanding** | Auto-detect pnpm/npm/yarn/lerna/melos workspaces, show structure on overview, adjust all checks per-package | Tools treat monorepos as single projects |
| **Composite Score** | Weighted 0-100 across all 25 checks with trends | SonarQube has quality gate, but not a single score |
| **Zero-Config** | Auto-detects stack, runs everything, one command | Every other tool requires config files |
| **Workspace-Aware Report** | Shows repo structure (mono/single), packages, before assessing | Nobody shows understanding before assessment |
| **Trend History** | Score timeline with sparklines, per-check trends over time | SonarQube has this (enterprise) |
| **Best Practices Audit** | CI/CD, OIDC, supply chain, repo hygiene, pre-commit hooks | GitHub security tab (partial) |

## Tool Ecosystem Map

### Linters (AST-based)
- **biome** — fastest TS/JS linter+formatter, growing rule set
- **eslint** — most plugins, most mature, slower
- **oxlint** — Rust-based eslint alternative, fast but fewer rules
- **deno lint** — Deno-specific

### Type Checking
- **tsc** — the only real TypeScript checker
- **@typescript-eslint** — type-aware lint rules ON TOP of tsc

### Security
- **semgrep** — pattern-based (like us) but with proper AST, 3000+ rules, free for open source
- **CodeQL** — GitHub's deep analysis, free for public repos, data flow tracking
- **eslint-plugin-security** — 13 rules, unmaintained since 2023
- **Snyk** — commercial, deepest vuln DB, auto-fix PRs
- **socket.dev** — supply chain security, detects typosquatting/malware

### Secrets
- **gitleaks** — gold standard, 800+ patterns, scans git history
- **trufflehog** — similar to gitleaks, by Truffle Security
- **git-secrets** — AWS-focused, older

### Quality / Complexity
- **SonarQube** — enterprise standard, 5000+ rules, free community edition
- **jscpd** — dedicated copy-paste detector (AST tokens)
- **Madge** — dependency graph visualization only

### Testing
- **vitest** — we run it
- **jest** — we run it
- **c8/istanbul** — coverage (we read their output)
- **Playwright** — E2E (we detect it)

### Accessibility
- **eslint-plugin-jsx-a11y** — lint-time a11y (what we approximate)
- **axe-core** — runtime a11y testing in browser (much deeper)
- **Lighthouse** — Google's audit (a11y + performance + SEO)

## Strategy

1. **Delegate** where dedicated tools exist and we already invoke them (lint, types, tests, audit)
2. **Complement** where our regex catches obvious patterns that linters miss (localStorage audit, .env committed, CI/CD hygiene)
3. **Own** what nobody else does (architecture diagrams, AI readiness, monorepo understanding, composite scoring)
4. **Document** what goes deeper — show "Go deeper" links in the report for each check
5. **Don't compete** with AST-based tools on pattern accuracy — our value is breadth + zero-config + the score
