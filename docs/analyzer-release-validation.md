# Analyzer Release Validation

This policy applies to analyzer and scanner bug fixes distributed through
`@vibecodeqa/cli`. A fix is not fully delivered while it only exists in a local
worktree, an unpublished branch, or an unreleased merge.

## Delivery States

- `fixed locally`: the source change exists in a local worktree or branch, but
  it has not been merged to the default branch. Do not describe this as
  delivered.
- `merged`: the source change has landed on the default branch. It is available
  to contributors from source, but downstream users still will not receive it
  through `npx @vibecodeqa/cli` unless a containing npm version is published.
- `published`: an npm package version containing the fix is available from the
  registry and `npm view @vibecodeqa/cli version` returns that version or newer.
- `validated downstream`: the affected consuming repo has been scanned with the
  published npm CLI version, or it is explicitly documented as using a local/dev
  build for validation.

Use the earliest accurate state in reports and issue comments. For example,
write "fixed locally, pending release" or "merged, not yet published" instead of
"delivered" when downstream users still run an older npm package.

## Closing Checklist

Before closing an analyzer bug or scanner-fix issue, the closing comment must
include one of the following outcomes.

### Published And Validated

- Commit or PR that contains the fix.
- Published npm version that contains the fix.
- Registry validation command and result:

```bash
npm view @vibecodeqa/cli version
```

- Downstream scan command that actually used the published version, including
  the version selector when relevant, for example:

```bash
npx --yes @vibecodeqa/cli@0.54.0 --skip-tests .
```

- Brief validation result from the affected consuming repo.

### Explicitly Unreleased

Only close as source-complete, not delivered, when all of these are documented:

- Commit or PR that contains the source fix.
- State is `fixed locally` or `merged`, not `published`.
- Follow-up release issue is linked.
- The comment states that downstream `npx @vibecodeqa/cli` users will not see
  the fix until a containing npm version is published.

### Local/Dev Downstream Validation

Only use this state when the consuming repo intentionally validates against a
local checkout or dev build:

- Commit or PR that contains the source fix.
- Exact local/dev CLI command used by the consuming repo.
- The comment states that this is not equivalent to a published npm release.
- Follow-up release issue is linked unless a publish is already in progress.

## Comment Template

```text
State: published and validated downstream
Fix: <commit or PR>
Published version: @vibecodeqa/cli@<version>
Registry check: npm view @vibecodeqa/cli version -> <version>
Downstream validation: <repo> ran `npx --yes @vibecodeqa/cli@<version> <args>`
Result: <brief result>
```

For unreleased source work, replace the state and version lines with:

```text
State: merged, not yet published
Fix: <commit or PR>
Published version: not available yet
Follow-up release issue: <issue>
Downstream impact: users running `npx @vibecodeqa/cli` will not receive this fix
until a containing npm version is published.
```
