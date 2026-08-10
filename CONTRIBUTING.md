# Contributing to VibeCode QA

There are two ways in, and they are not the same workflow. Pick the one that
describes you before you write any code.

- **You have write access to `vibecodeqa/cli`** (maintainers, and agents working
  in this repo) → [Workflow A](#workflow-a--if-you-have-write-access). Commit
  straight to `main`. Do not open a branch or a pull request.
- **You do not** (everyone else — the repo is public and contributions are
  welcome) → [Workflow B](#workflow-b--if-you-do-not-have-write-access). Fork,
  branch on your fork, open a pull request from the fork.

Not sure? Run `gh repo view vibecodeqa/cli --json viewerPermission`. `ADMIN`,
`MAINTAIN` or `WRITE` means Workflow A; anything else means Workflow B.

Only the workflow differs. Everything from [Adding a new check](#adding-a-new-check)
onwards — the architecture map, code style, and the stack-gating rule — applies
to both audiences equally.

## Workflow A — if you have write access

This project is trunk-based. `main` is the only ref that ships, there is no
review gate to satisfy, and there is no PR path to npm. Branches and pull
requests are not used here — not for features, not for fixes, not for
dependency bumps. See `CLAUDE.md` for the full rule and its rationale.

```bash
git clone https://github.com/vibecodeqa/cli.git
cd cli
pnpm install
pnpm build
pnpm test
node dist/cli.js  # self-scan
```

1. Work from an up-to-date `main` (`git pull --rebase`)
2. Make changes in `src/`
3. Run `pnpm build && pnpm test` — the full suite must pass
4. Run `node dist/cli.js --skip-tests` to self-scan and verify the report
5. Commit to `main` and push

## Workflow B — if you do not have write access

You cannot push to `vibecodeqa/cli`, so the fork is not optional — skipping it
gets you a permission denial at `git push`.

```bash
gh repo fork vibecodeqa/cli --clone   # or fork in the UI, then clone your fork
cd cli
pnpm install
pnpm build
pnpm test
node dist/cli.js  # self-scan
```

1. Create a branch on **your fork** (`git switch -c my-change`)
2. Make changes in `src/`
3. Run `pnpm build && pnpm test` — the full suite must pass
4. Run `node dist/cli.js --skip-tests` to self-scan and verify the report
5. Push to your fork and open a pull request against `vibecodeqa/cli`'s `main`

A maintainer reviews it and lands it. Opening an issue first is appreciated for
anything larger than a bug fix, so the design can be agreed before you build it.

> **Why two workflows?** The repo is public and takes outside contributions, but
> maintainers work trunk-based (`CLAUDE.md`). One document cannot give both
> audiences the same instruction without being wrong for one of them. Splitting
> it was chosen over making this file external-only, and over declaring the repo
> closed to outside contributions — see issue #88 for the alternatives weighed.

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

Analyzer bug fixes are not fully delivered just because the source change exists in this repository. Before closing a scanner-fix issue, follow the release and downstream validation checklist in `docs/analyzer-release-validation.md`.

**Stack gating rule:** a check either declares `appliesTo` in its CheckMeta (gated — the scan core skips it centrally) or is stack-blind. Framework conditionals inside generic runners are rejected in review; put framework logic in that framework's own check (see `runners/react.ts`).
