# Internal Analyzer Contract

Status: internal v0 proposal. This is not a public plugin SDK.

This document turns the analyzer-platform roadmap into implementation rules for
the CLI. It is the bridge between the current runner model and future
process-isolated analyzers.

Related specs:

- `language-profiles.md` defines language facts, project markers, generated
  files, and toolchain defaults.
- `repo-discovery.md` defines deterministic repo/project discovery and
  package-scoped scanning. This is core infrastructure, not an LLM feature.
- `out-of-process-analyzers.md` defines the internal process protocol for
  analyzers that do not run inside the CLI process.

## Goals

- Keep the CLI as the single analyzer engine.
- Replace the hardcoded runner registry with typed analyzers.
- Preserve the current `VibeReport` and `CheckResult` shape while the migration
  is incremental.
- Give framework analyzers a clear home without adding framework branches to
  generic runners.
- Make settings, metrics, findings, tool provenance, and error states consistent.
- Make repo and package discovery deterministic, auditable, and available
  without LLM tokens.
- Design the internal boundary so a future public plugin SDK can be added without
  rewriting the product.

## Non-Goals

- No public marketplace.
- No third-party plugin loading.
- No remote plugin registry.
- No arbitrary UI contribution model.
- No LLM-dependent repo discovery or folder scanning.
- No breaking report schema changes in the first migration.

## Terms

- **Analyzer**: a built-in or internal scan capability scheduled by the CLI.
- **Framework analyzer**: an analyzer whose answers depend on framework
  semantics, such as React hooks, Flutter widget tests, or .NET test projects.
- **Out-of-process analyzer**: an analyzer process launched by the CLI and
  connected through JSON over stdio.
- **Project context**: a deterministic description of one package/project inside
  the repo, including roots, stack, tool commands, and discovery evidence.
- **Plugin SDK**: a later public third-party surface with manifests, trust,
  compatibility, conformance tests, and lifecycle rules.

## Contract

The initial contract wraps the existing `CheckResult` model. It should not force
all runners to rewrite their output at once.

```ts
export type AnalyzerKind =
  | "generic"
  | "framework"
  | "ecosystem"
  | "integration"
  | "pro";

export interface AnalyzerManifest {
  id: string;
  name: string;
  kind: AnalyzerKind;
  resultSchemaVersion: number;
  appliesTo?: AppliesTo;
  settingsSchema?: AnalyzerSettingsSchema;
  metricDefinitions?: AnalyzerMetricDefinition[];
}

export interface Analyzer {
  manifest: AnalyzerManifest;
  detect?: (ctx: AnalyzerContext) => AnalyzerDetection | Promise<AnalyzerDetection>;
  run: (ctx: AnalyzerContext) => CheckResult | Promise<CheckResult>;
}

export interface AnalyzerContext {
  cwd: string;
  workspace: WorkspaceInfo;
  projects?: ProjectContext[];
  project?: ProjectContext;
  stack: StackInfo;
  config: VcqaConfig;
  settings: Record<string, unknown>;
  effectiveSettings: Record<string, unknown>;
  skipTests: boolean;
  srcRoots?: string[];
  ignoreNames: string[];
}

export interface AnalyzerDetection {
  applies: boolean;
  confidence: number;
  reason?: string;
  evidence?: AnalyzerEvidence[];
}
```

`manifest.id` must match the existing check name while the report format is
backward compatible. A derived/synthetic check, such as `dead-code`, must set
`details.synthetic = true` and must not affect scoring unless it is promoted into
`CHECK_META`.

Repo-level analyzers receive the whole `projects` list. Project-scoped analyzers
receive one `project` at a time and the scan engine aggregates their compatible
results. This prevents every runner from inventing its own monorepo traversal.

## Registry

The registry owns analyzer order. Scan orchestration must consume the registry
instead of hardcoding runner entries in `core.ts`.

```ts
export const ANALYZERS: Analyzer[] = [
  structureAnalyzer,
  lintAnalyzer,
  reactAnalyzer,
  // ...
];
```

Registry requirements:

- Preserve current CLI summary order unless a change is intentional.
- Every canonical analyzer id must exist in `CHECK_META`.
- Every analyzer with framework or language applicability must declare it in
  metadata, not inside a generic runner.
- Analyzer registration is the only place new built-in analyzers are added.

## Scan Lifecycle

For each analyzer:

1. Build `AnalyzerContext`.
2. Select repo or project scope from the analyzer manifest.
3. Apply central `appliesTo` stack gating.
4. Merge defaults and user settings.
5. Start tool recording.
6. Run the analyzer.
7. Attach package-tagged tool provenance from `exec.ts`.
8. Apply per-check ignore filters.
9. Validate output.
10. Add normalized metrics when available.
11. Preserve legacy `CheckResult.details` for current consumers.

Analyzer failures must become auditable check results. A failed analyzer must not
crash the entire scan unless the scan engine itself is corrupt.

## Settings

Analyzers may declare settings through a JSON-schema-compatible subset:

```ts
export interface AnalyzerSettingsSchema {
  type: "object";
  properties: Record<string, AnalyzerSetting>;
  required?: string[];
}

export type AnalyzerSetting =
  | { type: "boolean"; default: boolean; title?: string; description?: string }
  | { type: "number"; default: number; minimum?: number; maximum?: number; title?: string; description?: string }
  | { type: "string"; default: string; enum?: string[]; title?: string; description?: string }
  | { type: "array"; default: string[]; items: { type: "string" }; title?: string; description?: string };
```

Settings sources:

1. Analyzer defaults.
2. `.vcqa.json` or `package.json#vcqa`.
3. CLI flags when a setting has a deliberate flag mapping.
4. Monitor settings passed into the scan.

Invalid settings should fall back to defaults and add an analyzer warning in
details. Secrets must never be recorded in effective settings.

## Metrics

Metrics are for dashboards and trends. They are not a replacement for findings.

```ts
export interface AnalyzerMetric {
  id: string;
  label: string;
  value: number | string | boolean;
  unit?: "count" | "percent" | "ms" | "bytes" | "score";
  trend?: "higher-is-better" | "lower-is-better" | "neutral";
}

export interface AnalyzerSnapshot {
  analyzerId: string;
  status: "passed" | "failed" | "skipped" | "unavailable" | "error";
  score?: number;
  findingCount: number;
  severityCounts: Record<string, number>;
  metrics: AnalyzerMetric[];
  durationMs: number;
}
```

Reports now carry normalized summaries under `meta.analyzerSnapshots[]`. The
scan core builds these snapshots from every normalized check so dashboard and
trend consumers do not need to parse bespoke `details` fields.

Analyzers may still emit explicit metrics under `check.details.metrics`; the
snapshot builder preserves those when present. When an analyzer has no explicit
metrics, the builder derives conservative scalar metrics from stable detail
fields and ignores bulky/debug fields such as `toolRuns`, graphs, SVGs, and
free-form assessments.

## Scoring And Applicability

Check metadata declares default scoring semantics separately from numeric
weight:

- `available-scored`: the check is applicable and contributes to aggregate
  score.
- `available-unscored`: the check is applicable and advisory; findings are
  visible, but score impact is zero.
- `not-applicable`: the stack or repo shape is absent; the check is skipped and
  excluded from score and issue counts in rollups.
- `unavailable`: required product tier, plugin, license, or tool support is not
  available; the check is rendered separately and excluded from score.

The scan core writes runtime `details.scoreMode` and `details.scoreImpact` after
central stack gating and result normalization. UI code must use those fields
instead of inferring intent from `weight = 0`, `skipped`, or `comingSoon`.

`available-unscored` checks are advisory even when they emit findings or a low
numeric score. Normalized JSON reports keep `status: "passed"` for those checks
unless the runner itself failed to execute. When advisory findings are present,
the core also writes `details.advisoryFindings = true`. Consumers should treat
`status: "failed"` as a scored quality-gate failure and use
`details.advisoryFindings` plus `details.scoreImpact === false` for advisory
attention states.

## Findings

Findings should continue to map to `Issue` while normalized fields evolve:

```ts
export interface AnalyzerFinding {
  id: string;
  ruleId: string;
  category: string;
  severity: "error" | "warning" | "info";
  title: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  evidence?: unknown;
  recommendation?: string;
}
```

Current `Issue.rule` maps to `ruleId`. Current `Issue.message` maps to
`message`. The app should keep rendering legacy issues until all analyzers emit
normalized findings.

## Tool Provenance

All delegated tools must use the shared execution helpers so reports can answer:

- exact command
- working directory
- exit code
- duration
- stdout/stderr or captured output
- whether output was truncated
- analyzer/check that used the tool

An analyzer that shells out without provenance is not acceptable.

## Framework Analyzer Rules

Create a framework analyzer only when framework semantics materially change the
answer. Examples:

- React hooks and compiler diagnostics belong in React.
- Flutter widget test pairing belongs in Flutter.
- .NET solution/test-project mapping belongs in .NET.
- Duplicate code does not belong in a framework analyzer.
- Secrets do not belong in a framework analyzer.

Generic analyzers must not branch on `stack.framework`. Use `appliesTo` gating or
move framework-specific behavior into a framework analyzer.

## Migration Checklist

When converting an existing runner:

- [ ] Wrap it in an `Analyzer` object.
- [ ] Move applicability into `manifest.appliesTo`.
- [ ] Keep the output `CheckResult` compatible.
- [ ] Preserve check order.
- [ ] Preserve tool provenance.
- [ ] Preserve per-check ignore behavior.
- [ ] Add or preserve tests for `--checks` filtering.
- [ ] Add metrics only if they are stable enough to trend.
- [ ] Add settings only if there is an actual user-facing decision.
- [ ] Update docs if the analyzer owns framework semantics.

## Example: React

The React migration should:

- Keep `id = "react"`.
- Keep current heuristic issues.
- Add official React lint/compiler diagnostics when available.
- Classify details into stable buckets: hooks, effects, compiler-readiness,
  rendering, component-structure, fast-refresh, accessibility, error-boundary.
- Emit metrics for each bucket.
- Power the app's future React Health page without raw lint parsing.

## Example: Dead Code

`dead-code` is currently a derived row over data gathered by `performance`/Knip.
It is useful for UI clarity but is not a canonical weighted analyzer yet.

Rules for derived rows:

- set `details.synthetic = true`
- set `details.sourceCheck`
- do not change aggregate score
- avoid rerunning the same delegated tool in full scans
- preserve tool provenance from the source check

## Versioning

Internal analyzer contracts can change while marked v0. Once at least several
built-in analyzers use the contract, introduce explicit result schema versions
and conformance fixtures before any public SDK work.
