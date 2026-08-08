# Exclusion Policy

VCQA builds one `EffectiveScanPolicy` at scan startup. The versioned default
exclusions live in `src/data/default-exclusions.json` and are exposed from the
published package as `@vibecodeqa/cli/exclusion-policy`; project/user inputs are
merged into that policy before file inventory and analyzer execution.

Scanner code should apply that policy; it should not maintain analyzer-local
copies of directory names. External tool adapters should normalize emitted paths
to repo-root-relative paths, then filter findings through the same effective
policy behavior.

## One Engine

`evaluatePath(policy, relPath)` in `src/scan-policy.ts` is the only place the
matching rules live. Everything else calls it:

- `buildFileInventory()` walks with it, so the inventory is the policy's own
  answer about the repo.
- `fs-utils`' shared walkers (`collectSourceFiles`, `collectAllFiles`,
  `getProductionFiles`, `getTestFiles`) call it per entry.
- `isIgnoredPath()` — the filter runners apply to Biome/ESLint/tsc/gitleaks
  output — is `evaluatePath(...).excluded` and nothing else.

`core.ts` installs the scan's policy with `setGlobalScanPolicy()` after
`setGlobalIgnore()`/`setGlobalIgnoreNames()` (both of which reset it). A caller
that never ran a full scan — a direct runner call or a unit test — gets an
equivalent policy derived from those globals via `scanPolicyFromInputs()`, so
the rules are identical and only the evidence provenance is coarser.

Runners receive the policy through the `FileInventory` they are handed:

```ts
inventory.policy                          // the EffectiveScanPolicy itself
inventoryIsIgnored(inventory, path)       // ctx.isIgnored(path)
inventoryClassify(inventory, path)        // ctx.classify(path) — full decision
inventoryExplain(inventory, path)         // one-line reason, for UI and logs
inventoryHas(inventory, path)             // did the walk actually produce it?
```

Do not add a second copy of the directory names, glob matching, or hidden-file
rules anywhere. If a runner needs a different universe, it needs a different
*query* against the inventory, not a different *policy*.

Note that `isIgnoredPath()` reports the `exclude` action only. A
security-sensitive file that is merely ignored by project config
(`include-security-sensitive`) is not "ignored" for this purpose — that is the
override working as designed, and secrets findings in a config-ignored `.env`
survive the filter.

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

## The File Inventory

The policy decides; the `FileInventory` is the answer it produced. `core.ts`
builds exactly one per scan, before any runner runs, and hands it to every
runner that consumes files. A runner asks the inventory for the files it needs
— it does not walk the repo.

```ts
inventorySourceFiles(inv, { includeTests })  // source (and test) files
inventoryTestFiles(inv)                      // test files only
inventoryAllFiles(inv, { extraExts })        // whole-repo universe
inventoryFiles(inv, { kind, ext, includeGenerated, includeIgnored })
```

`inventory.files` is what the scan may look at. `inventory.ignoredFiles` is what
the walk reached and the policy rejected, each entry carrying its reason codes.
Ignored *directories* are pruned whole and never enumerated — that is the
traversal boundary, and it is what keeps `node_modules` off the heap — so the
rejected list stays small: lockfiles, minified bundles, source maps, generated
`.g.dart`.

That list exists for one narrow case: a check that *measures* something the scan
otherwise excludes. `flutter` reports a generated-to-handwritten Dart ratio, so
it needs `*.g.dart` paths the policy rejects. It asks the inventory with
`includeIgnored: true` rather than re-walking the repo behind a private skip
list. Reach for it only with that kind of justification.

Report metadata carries `meta.fileInventory` with counts by class (`byKind`) and
by ignored reason (`ignoredByReason`), so a reader can audit what the scan looked
at and why it skipped the rest.

### Walks that remain, and why

Every runner that scans repo *content* takes the inventory. What is left is
deliberate:

- **External tool adapters** — `lint` (biome/eslint/dart analyze) and `types`
  (tsc) let the tool do its own discovery, then normalize emitted paths to
  repo-root-relative and filter them through `isIgnoredPath()`. Same policy,
  applied after the fact.
- **Targeted, non-recursive reads of known paths** — `env-validation` listing
  root `.env*`, `container-health` listing root Dockerfiles/compose files,
  `lint` and `best-practices` reading `.github/workflows/`, `sqlite-d1` reading
  a migrations directory. These name a specific location; they cannot leak an
  ignored subtree.
- **`dependencies` reading `node_modules/`** — the dependency tree is
  deliberately outside the scan universe, and inspecting it is the whole check.
- **`flutter`'s `findPubspecDirs`** — project discovery, not file scanning.
- **Legacy fallbacks** — several runners keep their old walk for direct callers
  that never ran a scan and so have no inventory. The scan never takes those
  paths; `core.ts` always passes the inventory.

`analyzer-conformance.test.ts` enforces the boundary: it runs a full scan over a
fixture seeded with `dist/`, `coverage/`, `playwright-report/`, `node_modules/`,
`.claude/worktrees/`, a config-ignored directory, a lockfile and a minified
bundle, then asserts that no finding from any check names an excluded path and
that every finding names a file the inventory holds (or one of a short list of
repo-level markers a check may point at when the file does not exist).

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
`evaluatePath()`, and a one-line human-readable form from `explainPath()`. Every
path the scan skips is explainable this way — including paths the walk never
produced, since the policy can be asked about a path directly.

App, MCP, and plugin consumers should read the shared registry from:

```ts
import {
  defaultExclusionPolicy,
  defaultExclusionPolicySummary,
  defaultExclusionReasonCodes,
} from "@vibecodeqa/cli/exclusion-policy";
```

Do not copy the registry into another package or UI bundle by hand. If a
consumer needs the values, import the public module from the installed CLI
package so the effective policy version stays auditable.

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

- Add entries to `src/data/default-exclusions.json`, not to runner code. The
  public `@vibecodeqa/cli/exclusion-policy` export is the supported read surface
  for apps and future plugins.
- Include a reason category so the UI can eventually explain why a path was
  skipped.
- Keep the registry defensible and cross-project. Standard generated/cache
  output belongs here; project-specific folders belong in `.vcqa.json`,
  `package.json#vcqa.ignore`, or `VCQA_IGNORE`.
- Do not encode downstream customer, product, or repository names in defaults
  or production scanner code. If a real repo exposes a false positive, first
  model the generic shape (`site/generated-docs/**`, `services/api/**`,
  `apps/web/**`, and similar neutral paths), then add the project-specific path
  only to that repo's config.
- Add directory names only when the directory is normally generated or external
  to product source. Avoid broad names such as `bin` when they commonly hold
  checked-in scripts.
- Add or update tests for `EffectiveScanPolicy`, `isIgnoredPath()`, and any
  analyzer with a custom file walk.
- Keep analyzer-specific behavior explicit. Dependency checks may need lockfiles;
  complexity, HTML quality, and dead-code usually should not scan generated
  artifacts.

## Downstream Regression Fixtures

Tests may keep a downstream-shaped fixture only when it reproduces a real false
positive or false negative that a neutral fixture failed to capture. Mark those
cases as downstream regressions in the test name or comment, and pair them with a
neutral fixture that proves the general behavior.

Production code must remain free of repo-specific names such as customer/product
brands or one-off internal folder layouts. `downstream-fixture-guard.test.ts`
enforces that boundary for scanner source files.

## Future Shape

If the app or plugin SDK needs independent release cadence later, extract the
same module into a small versioned package such as
`@vibecodeqa/exclusion-policy`. Until then, the CLI package export is the shared
registry surface.
