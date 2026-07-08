# Changelog

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
