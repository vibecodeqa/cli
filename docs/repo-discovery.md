# Repo Discovery and Workspace Scanning

Status: internal v0 proposal.

Repo discovery is core analyzer infrastructure. It must be deterministic,
auditable, and available without LLM tokens. AI/Pro features may explain,
suggest, or help edit configuration, but they must not be required for VCQA to
decide what projects exist or where tools should run.

## Decision

VCQA will treat repo type and folder discovery as a free/core capability.

The scan engine owns:

- repository root normalization
- workspace/project discovery
- package-level stack and tool detection
- source/test/config root selection
- generated and ignored path classification
- analyzer scheduling per project
- package-tagged tool provenance

LLM-assisted features may add:

- natural-language explanations of repo architecture
- suggested custom excludes or generated-file classifications
- proposed analyzer settings
- summaries of ambiguous ownership or architectural intent
- chat over detected projects and architecture decisions

LLM output must never be the only source of truth for whether a folder is
scanned.

## Discovery Pipeline

The deterministic pipeline is:

1. Normalize the repo root.
2. Read root config: `.vcqa.json`, `package.json#vcqa`, workspace manifests, and
   gitignore directory rules.
3. Enumerate project candidates from language-profile project markers and common
   workspace conventions.
4. Classify each candidate with evidence and confidence.
5. Build a project context for every accepted package.
6. Detect stack/toolchain per package, not only at the root.
7. Schedule analyzers against the repo or package scope they declare.
8. Run delegated tools in the package cwd when that is where the tool config
   lives.
9. Normalize all findings and tool logs back to repo-root-relative paths.
10. Emit package-aware metrics, findings, and tool provenance.

## Project Context

Workspace scanning needs a richer package model than a path list:

```ts
export interface ProjectContext {
  id: string;
  name: string;
  path: string;          // "." for repo root; otherwise repo-root-relative package root
  kind: "root" | "package" | "app" | "service" | "library" | "unknown";
  srcRoots: string[];
  testRoots: string[];
  configFiles: string[];
  manifestFiles: string[];
  stack: StackInfo;
  toolCommands: {
    lint?: ToolCommand[];
    typecheck?: ToolCommand[];
    test?: ToolCommand[];
    audit?: ToolCommand[];
  };
  evidence: DiscoveryEvidence[];
  confidence: number;
}

export interface ToolCommand {
  tool: string;
  cwd: string;           // repo-root-relative execution cwd
  command: string[];
}

export interface DiscoveryEvidence {
  kind: "manifest" | "config" | "convention" | "source" | "tooling" | "rejected";
  description: string;
  file?: string;
  path?: string;
  value?: string;
}
```

The current `WorkspaceInfo` can remain for report compatibility, but scan
orchestration should move toward `ProjectContext[]`.

Rejected convention candidates are recorded under `workspace.discovery.evidence`
with `kind = "rejected"`. They are intentionally not emitted as
`ProjectContext` entries.

## Discovery Sources

Accepted deterministic sources:

- workspace manifests: `pnpm-workspace.yaml`, `package.json#workspaces`,
  `lerna.json`, `nx.json`, `turbo.json`, `melos.yaml`
- project manifests from enabled language profiles: `package.json`,
  `pubspec.yaml`
- package-local tool config: `tsconfig.json`, `biome.json`,
  `eslint.config.*`, `vitest.config.*`, `pubspec.yaml`
- conservative folder conventions: `apps/*`, `packages/*`, `workers/*`,
  `jobs/*`, `services/*`, `libs/*`, plus shallow nested folders under those
  roots when they contain a supported manifest or tool config
- user config: explicit include/exclude/project roots

Unsupported language markers must not be enabled globally until VCQA can produce
honest results for that language. For example, discovering `.sln` or `pom.xml`
before .NET/Java analyzers are ready would mostly create skipped checks and a
misleading report.

## Scoping Rules

Analyzers must declare their scope:

- **repo**: one result for the whole repository, such as git hygiene
- **project**: run once per project and aggregate, such as lint/types/tests
- **file graph**: use merged source graph but preserve project ids
- **derived**: read another analyzer's result and do not run tools again

Project-scoped analyzers must tag findings, metrics, and `toolRuns` with the
project id/path. The app can then show page logs for the current analyzer and
project without mixing unrelated output.

## Free vs Pro

Free/core:

- deterministic discovery
- project context generation
- package-level tool execution
- path normalization
- generated/exclusion policy
- evidence and confidence reporting

Pro/AI:

- explain why a repo appears to be organized a certain way
- recommend custom settings
- propose new language profile entries
- compare detected architecture to docs and ADRs
- chat over architecture topics and decisions

If AI is unavailable, the scan must still run correctly.

## Acceptance Criteria

- A manifest monorepo and a convention-only monorepo both produce multiple
  project contexts.
- Lint, typecheck, and test analyzers run in package cwd when package config
  lives there.
- Tool logs include analyzer id, project id/path, cwd, command, exit status, and
  output.
- Findings use repo-root-relative paths and include project id/path where known.
- Unsupported project types are reported as unsupported/unavailable, not as
  failed checks.
- UI pages can filter by analyzer and project without reading global logs.
