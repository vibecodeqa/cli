# Contributing to VibeCode QA

## Quick setup

```bash
git clone https://github.com/vibecodeqa/cli.git
cd cli
pnpm install
pnpm build
pnpm test
node dist/cli.js  # self-scan
```

## Development workflow

1. Create a branch from `main`
2. Make changes in `src/`
3. Run `pnpm build && pnpm test` — all 109 tests must pass
4. Run `node dist/cli.js --skip-tests` to self-scan and verify the report
5. Push and open a PR

## Adding a new check

1. Create `src/runners/your-check.ts` — export a `runYourCheck(cwd)` function returning `CheckResult`
2. Add metadata to `src/check-meta.ts` — name, label, category, weight, description, risk, recommendation
3. Wire it in `src/cli.ts` (import + add to runners array)
4. Add it to the correct group in `src/report/html.ts` (GROUPS array)
5. Add tests in `src/runners/your-check.test.ts`
6. Adjust weights to sum to 100

## Architecture

- `src/cli.ts` — entry point, flag parsing, orchestration
- `src/runners/` — one file per check, each returns `CheckResult`
- `src/fs-utils.ts` — shared file walker (all runners must use this)
- `src/report/` — HTML page generation (multi-page, separate files)
- `src/check-meta.ts` — metadata for all checks (weights, descriptions)

## Code style

- Zero runtime dependencies
- TypeScript strict mode
- Biome for linting/formatting (`pnpm lint`)
- Every runner uses `fs-utils.ts` for file walking (symlink + size protection)

## Publishing

Push to `main` auto-publishes to npm via OIDC trusted publishing when the version in `package.json` changes. No tokens needed.

**Stack gating rule:** a check either declares `appliesTo` in its CheckMeta (gated — the scan core skips it centrally) or is stack-blind. Framework conditionals inside generic runners are rejected in review; put framework logic in that framework's own check (see `runners/react.ts`).
