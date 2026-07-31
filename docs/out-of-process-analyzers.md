# Out-of-Process Analyzers

Status: internal v0 proposal. This is not a public plugin SDK.

Out-of-process analyzers let the CLI run analyzers that are not TypeScript
modules or that need isolation. This is required before public plugins, but it
starts as an internal mechanism for built-in analyzers and adapters.

This protocol implements the process-isolated side of
`internal-analyzer-contract.md`.

## Goals

- Keep the CLI as the single analyzer engine.
- Run non-TypeScript analyzers without loading them into the CLI process.
- Preserve tool provenance, timeouts, and crash attribution.
- Keep report output compatible with `VibeReport`.
- Prove the process boundary before third-party plugin work.

## Non-Goals

- No remote registry.
- No marketplace.
- No third-party install flow.
- No plugin trust UI in the CLI.
- No arbitrary UI contribution.

## v0 Framing

Use one JSON request on stdin and one JSON response on stdout.

Streaming events are a separate concern tracked by the scan streaming/tool-log
work. A later version can add NDJSON events if needed.

```text
vcqa
  spawn analyzer command
  write ProjectContext JSON to stdin
  read AnalyzerProcessResult JSON from stdout
  capture stderr as diagnostic output
```

## Request

```ts
export interface AnalyzerProcessRequest {
  protocolVersion: 0;
  scanId: string;
  analyzerId: string;
  cwd: string;
  stack: StackInfo;
  workspace: WorkspaceInfo;
  languageProfiles: string[];
  settings: Record<string, unknown>;
  ignoreNames: string[];
  env?: Record<string, string>;
}
```

Do not pass secrets unless the analyzer explicitly requires them and the user has
approved that capability. v0 internal analyzers should avoid secret input.

## Response

```ts
export interface AnalyzerProcessResult {
  protocolVersion: 0;
  analyzerId: string;
  status: "passed" | "failed" | "skipped" | "unavailable" | "error";
  check: CheckResult;
  metrics?: AnalyzerMetric[];
  artifacts?: AnalyzerArtifact[];
  warnings?: string[];
  effectiveSettings?: Record<string, unknown>;
}

export interface AnalyzerArtifact {
  id: string;
  kind: "json" | "text" | "html" | "svg" | "coverage" | "log";
  path?: string;
  inline?: unknown;
}
```

The process result should contain exactly one check result in v0. Multi-check
plugins can be considered later, after single-check analyzers are stable.

## Errors

The engine must turn failures into auditable check results.

| Failure | Engine behavior |
|---|---|
| process exits non-zero with parseable response | use response status and attach exit code |
| process exits non-zero without response | emit `status=error`, skipped/error check result, captured stderr |
| stdout is invalid JSON | emit malformed-output error |
| timeout | kill process, emit timeout error |
| missing executable | emit unavailable/skipped result with install hint when known |

An analyzer crash must not crash the scan.

## Provenance

Every out-of-process analyzer run must record:

- command
- args
- cwd
- start/end/duration
- exit code
- timeout flag
- stdout/stderr capture or truncation marker
- analyzer id

This provenance should flow through the same tool log UI as other delegated
tools.

## Security Model

v0 is internal only. It can run known local commands shipped with or selected by
VCQA. A future public SDK must add:

- manifest identity
- trust prompts
- local path approval
- capability declarations
- version compatibility
- disable/remove flow
- conformance tests
- plugin-originated error attribution

Do not expose third-party plugin loading until those exist.

## Candidate Internal Adapters

- graphify extraction
- migrated Rust scans
- Flutter/Dart tooling wrappers
- .NET spike analyzers
- Java/Spring spike analyzers

## Conformance Fixture

Every process analyzer should have a fixture command that can simulate:

- success
- skipped/unavailable
- malformed output
- non-zero exit
- timeout
- large stdout/stderr

The CLI test suite should verify each failure mode produces a valid report.
