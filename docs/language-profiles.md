# Language Profiles

Status: internal v0 proposal.

Language profiles centralize the facts that tell VCQA what a language looks like:
source extensions, test file patterns, generated files, visual-neutral files,
ecosystem skip directories, project markers, and default toolchain commands.

This spec feeds the analyzer contract in `internal-analyzer-contract.md`.
`repo-discovery.md` owns how profile facts become project contexts.

## Why Profiles Exist

Without profiles, the same facts drift across:

- file walking
- project discovery
- app views
- docs inventory
- graph views
- test pairing
- generated-file handling
- desktop watcher filters

Profiles are required before VCQA adds broad support for Python, .NET, Java,
Rust, Go, or other stacks. Do not add new project markers before the analyzer
engine can actually scan that stack.

## Contract

```ts
export interface LanguageProfile {
  id: string;
  label: string;
  codeExts: string[];
  sfcExts?: string[];
  testPatterns: string[];
  skipDirs: string[];
  generatedPatterns?: string[];
  visualNeutralPatterns?: string[];
  projectMarkers?: string[];
  toolchain: LanguageToolchain;
}

export interface LanguageToolchain {
  typecheck?: string[];
  lint?: string[];
  test?: string[];
  audit?: string[];
  format?: string[];
}
```

Patterns should be portable strings, not JavaScript `RegExp` objects, because the
app, CLI, MCP, and future out-of-process analyzers may need to read them.

## Initial Profiles

Initial profiles should cover only stacks VCQA can scan honestly:

- `typescript`
- `javascript`
- `dart`

Vue and Svelte can start as single-file-component extensions under the JS/TS web
profiles until they need full framework analyzers.

## Project Markers

Project markers determine candidate project roots. They must be conservative and
only come from deterministic repo evidence, never from LLM guesses.

Current allowed markers:

- `package.json`
- `pubspec.yaml`

Do not add these markers yet:

- `pyproject.toml`
- `*.csproj`
- `*.sln`
- `pom.xml`
- `build.gradle`
- `Cargo.toml`
- `go.mod`

Those markers would surface projects whose checks mostly skip. Add them only
when the matching language profile and analyzers are ready.

LLM/Pro features may suggest new markers or explain ambiguous folders, but the
profile registry is still the deterministic source of truth.

## Generated and Visual-Neutral Files

Generated files should normally be excluded from quality findings or treated as
visual-neutral in UI maps:

- lockfiles
- generated type files
- framework build output
- Flutter `*.g.dart` and `*.freezed.dart`
- protobuf/OpenAPI generated clients

Profiles should distinguish:

- **skip**: do not scan or display as source
- **generated**: scan only where relevant, suppress most quality findings
- **visual-neutral**: show in maps but avoid letting size/complexity dominate

## Consumer Rules

CLI consumers:

- file walker uses `codeExts`, `sfcExts`, and `skipDirs`
- test pairing uses `testPatterns`
- project discovery uses `projectMarkers`
- tool runners use `toolchain`

App consumers:

- views must not keep private source extension lists
- docs inventory must consume profile facts
- graph/layer views must prefer graph/report facts over extension regexes
- settings can expose profile-driven generated/visual-neutral overrides

Watcher consumers:

- Rust watcher filters must be generated from or kept in documented lockstep with
  profile data. A hand-mirrored list is temporary legacy.

## Adding a Language

Checklist:

- [ ] Add a profile.
- [ ] Add detection.
- [ ] Add fixture repo.
- [ ] Add or gate analyzers so discovered projects do not all skip.
- [ ] Add toolchain commands only when missing tools produce honest unavailable
      states.
- [ ] Update app views to consume profile data instead of adding private regexes.
- [ ] Add grep/test coverage that new extension literals live only in profiles,
      fixtures, tests, or parser-specific code.

## Relationship to Framework Analyzers

Profiles describe language conventions. Framework analyzers describe semantic
quality rules.

Examples:

- Dart profile knows `_test.dart`; Flutter analyzer knows widget test pairing.
- TypeScript profile knows `.tsx`; React analyzer knows hook/compiler rules.
- C# profile knows `.csproj`; .NET analyzer knows solution/test-project mapping.
