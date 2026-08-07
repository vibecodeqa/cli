# Exclusion Policy

VCQA builds one `EffectiveScanPolicy` at scan startup. The versioned default
exclusions live in `src/data/default-exclusions.json`; project/user inputs are
merged into that policy before file inventory and analyzer execution.

Scanner code should apply that policy; it should not maintain analyzer-local
copies of directory names. External tool adapters should normalize emitted paths
to repo-root-relative paths, then filter findings through the same effective
policy behavior.

## Effective Precedence

The policy records an action and evidence for every evaluated path:

- `include`: no ignore rule matched.
- `exclude`: normal scan traversal or findings should skip the path.
- `include-security-sensitive`: the path is ignored for normal analyzers, but is
  still included for narrow security-sensitive checks.

Current precedence is:

1. Security-sensitive file override for root `.env*` and key/certificate files.
   This override only applies when the matching ignore reason is project config,
   user ignore, `VCQA_IGNORE`, or a `.gitignore` directory rule.
2. Global project config from `.vcqa.json` or `package.json` `vcqa.ignore`.
3. User ignore names passed by callers.
4. `VCQA_IGNORE` names from the environment.
5. Versioned default exclusions and generated classification from
   `src/data/default-exclusions.json`.
6. Directory-only `.gitignore` rules.
7. Per-check ignores from `checks.<name>.ignore`, applied after runner output is
   normalized.

Generated/default artifact directories still win over the security-sensitive
override. For example, root `.env` can be included for secrets checks even if
`.vcqa.json` ignores `.env`, but `.claude/worktrees/agent/.env` remains excluded
because `.claude` is a generated agent artifact.

File-level `.gitignore` rules are not imported into the global policy. This is
intentional: `.env` being ignored by git is good hygiene, but it must not prevent
security analyzers from inspecting it. Directory `.gitignore` rules are imported
because they usually describe generated or bulky traversal boundaries.

## Reason Codes

Every policy match records evidence with a source, matched value, precedence,
and reason code. Current reason codes include:

- default classes: `dependency`, `vcs`, `vcqa`, `build-output`,
  `test-output`, `framework-cache`, `agent-artifact`, `runtime-cache`,
  `generated-file`, `lockfile`
- project/user classes: `config-ignore`, `user-ignore`, `env-ignore`,
  `gitignore-directory`
- special classes: `security-sensitive`, `hidden-directory`,
  `default-exclusion`

Reports expose a compact `meta.scanPolicy` summary with counts, values, reason
codes, precedence labels, and the security override mode. The summary is meant
for UI display and auditability; detailed per-path evidence is available from
`evaluatePath()`.

## What Belongs Here

Add paths that are normally not product source:

- dependency folders
- version-control internals
- build outputs
- test and coverage output
- framework caches
- generated agent/runtime worktrees
- temporary runtime caches
- package-manager caches and virtual environments
- generated source artifacts such as protobuf, generated TypeScript/Dart, and
  minified or bundled browser files
- static test/report artifacts such as `lcov.info`, JUnit XML, and coverage
  JSON

The default policy is explicit by design. Do not ignore every dot directory:
`.github`, `.storybook`, and similar repo/config folders are meaningful inputs
for several checks and should remain visible unless the project config excludes
them.

Do not add normal source folders just because one project does not care about
them. Those belong in project-level config.

## Maintenance Rules

- Add entries to `src/data/default-exclusions.json`, not to runner code.
- Include a reason category so the UI can eventually explain why a path was
  skipped.
- Keep the registry defensible and cross-project. Standard generated/cache
  output belongs here; project-specific folders belong in `.vcqa.json`,
  `package.json#vcqa.ignore`, or `VCQA_IGNORE`.
- Add directory names only when the directory is normally generated or external
  to product source. Avoid broad names such as `bin` when they commonly hold
  checked-in scripts.
- Add or update tests for `EffectiveScanPolicy`, `isIgnoredPath()`, and any
  analyzer with a custom file walk.
- Keep analyzer-specific behavior explicit. Dependency checks may need lockfiles;
  complexity, HTML quality, and dead-code usually should not scan generated
  artifacts.

## Future Shape

If multiple VCQA packages or plugins need to share this policy, extract it into
a small versioned package such as `@vibecodeqa/exclusion-policy`. Until then,
the CLI data file is the source of truth.
