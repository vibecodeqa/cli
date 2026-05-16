/** Metadata for each check — description, risk, priority, weight, recommendations.
 *  This is what makes the report educational, not just a scorecard. */

export type Priority = "critical" | "high" | "medium" | "low";

export interface CheckMeta {
	name: string;
	label: string;
	category: string;
	priority: Priority;
	weight: number;
	description: string;
	risk: string;
	recommendation: string;
	premium?: boolean;
}

export const CHECK_META: Record<string, CheckMeta> = {
	structure: {
		name: "structure",
		label: "Project Structure",
		category: "Foundations",
		priority: "high",
		weight: 6,
		description:
			"Checks for standard project files: package.json, tsconfig.json, LICENSE, README, .gitignore, lockfile. Verifies test-to-source file ratio and that essential scripts (test, build) exist.",
		risk: "Missing config files cause build failures in CI. Missing LICENSE makes the project legally ambiguous. No lockfile means non-reproducible builds — a dependency update can break production silently.",
		recommendation:
			"Ensure every project has package.json, tsconfig.json, LICENSE, .gitignore, and a lockfile. Add 'test' and 'build' scripts. Aim for at least one test file per source file.",
	},
	lint: {
		name: "lint",
		label: "Lint",
		category: "Foundations",
		priority: "high",
		weight: 5,
		description:
			"Runs the project's linter (Biome or ESLint, auto-detected) and counts errors and warnings. Lint rules catch bugs, enforce consistency, and prevent common mistakes before they reach production.",
		risk: "Unlinted code accumulates inconsistencies and latent bugs. Studies show that projects with active linting have 15-20% fewer production defects (Microsoft Research, 2019).",
		recommendation:
			"Fix all lint errors. Warnings can be addressed incrementally. If no linter is configured, add Biome (@biomejs/biome) — it's the fastest linter for TypeScript with zero config needed.",
	},
	types: {
		name: "types",
		label: "Type Check",
		category: "Foundations",
		priority: "critical",
		weight: 6,
		description:
			"Runs tsc --noEmit to find TypeScript compilation errors. Type errors mean the code may crash at runtime in ways the compiler could have prevented.",
		risk: "Type errors are bugs. Every unresolved type error is a potential runtime crash. TypeScript's type system exists to prevent entire categories of bugs — ignoring it negates its value.",
		recommendation:
			"Fix all type errors. If you're migrating from JavaScript, enable strict mode gradually — start with 'strict: true' and fix errors file by file.",
	},
	"type-safety": {
		name: "type-safety",
		label: "Type Safety",
		category: "Foundations",
		priority: "medium",
		weight: 3,
		description:
			"Counts unsafe type patterns: 'as any' casts, explicit ': any' annotations, @ts-ignore directives, @ts-nocheck, and non-null assertions (!.). Each weakens the type system's protection.",
		risk: "'as any' silences the type checker at that point — any bug the types would have caught now slips through. @ts-ignore and @ts-nocheck disable type checking entirely for a line or file. Accumulated 'any' usage correlates with higher defect density.",
		recommendation:
			"Replace 'as any' with proper types or type guards. Use 'unknown' instead of 'any' when the type is genuinely unknown. Remove @ts-ignore comments by fixing the underlying type issue.",
	},
	standards: {
		name: "standards",
		label: "Code Standards",
		category: "Foundations",
		priority: "medium",
		weight: 3,
		description:
			"Checks coding conventions: file naming (PascalCase for components, kebab-case for modules), file size limits (>300 lines flagged), code smells (console.log, var, ==, eval, innerHTML, TODO/FIXME), config hygiene (strict mode), and framework best practices (Tailwind vs inline styles).",
		risk: "Large files are hard to review and test. console.log in production leaks internal data. var causes hoisting bugs. == causes type coercion surprises. eval/innerHTML are security vulnerabilities. Inconsistent naming makes the codebase harder to navigate.",
		recommendation:
			"Split files over 300 lines. Replace console.log with a proper logger or remove it. Use const/let, ===, and safe DOM APIs. Enable TypeScript strict mode.",
	},
	"error-handling": {
		name: "error-handling",
		label: "Error Handling",
		category: "Quality",
		priority: "high",
		weight: 3,
		description: "Detects poor error handling: empty catch blocks, throw with string literals, catch-and-rethrow without context, Promise.then() without .catch(), missing React Error Boundaries.",
		risk: "Empty catch blocks silently swallow errors. throw 'string' loses stack traces. Missing Error Boundaries in React cause the entire app to crash on render errors.",
		recommendation: "Handle or log every catch. Use throw new Error() for stack traces. Add Error Boundaries in React. Chain .catch() on promises.",
	},
	complexity: {
		name: "complexity",
		label: "Complexity",
		category: "Quality",
		priority: "high",
		weight: 5,
		description:
			"Measures cognitive complexity of each function: how many branches (if/else/switch/for/while/ternary/&&/||) and how many lines. Functions over 60 lines or with complexity over 15 are flagged.",
		risk: "Complex functions are the #1 source of bugs. Research shows defect density increases exponentially with cyclomatic complexity above 10 (McCabe, 1976). Complex code is also harder to review, test, and modify safely.",
		recommendation:
			"Extract complex functions into smaller ones. Use early returns to reduce nesting. Replace conditional chains with lookup tables or strategy patterns. Aim for functions under 30 lines with complexity under 10.",
	},
	duplication: {
		name: "duplication",
		label: "Duplication",
		category: "Quality",
		priority: "medium",
		weight: 5,
		description:
			"Detects copy-pasted code blocks of 6+ lines across source files. Duplication is measured as a percentage of total source lines involved in duplicate blocks.",
		risk: "Duplicated code means bugs must be fixed in multiple places. Miss one copy and the bug persists. DRY (Don't Repeat Yourself) violations increase maintenance cost linearly with each copy.",
		recommendation:
			"Extract duplicated logic into shared functions or modules. If two files share the same pattern, create a helper. If the duplication is across repos, consider vendoring a shared module.",
	},
	docs: {
		name: "docs",
		label: "Documentation",
		category: "Quality",
		priority: "low",
		weight: 3,
		description:
			"Checks README quality (existence, length, sections) and JSDoc coverage (what percentage of exported functions/classes have documentation comments).",
		risk: "Undocumented code is hard to onboard to and easy to misuse. Missing README means new contributors can't get started. Undocumented exports become tribal knowledge that leaves when people leave.",
		recommendation:
			"Write a README with: what it does, how to install, how to run, how to develop. Add JSDoc comments to all public exports — even a one-line description helps.",
	},
	testing: {
		name: "testing",
		label: "Testing",
		category: "Testing",
		priority: "critical",
		weight: 15,
		description:
			"Deep assessment of test quality across 6 dimensions: pyramid presence (unit/integration/component/E2E layers), test execution (pass/fail), coverage (statement/branch/line/function), file pairing (test file per source file), test quality (assertion density, mock ratio, snapshot ratio), and E2E tool detection (Playwright/Cypress).",
		risk: "Code without tests is code you can't safely change. Missing test layers mean entire categories of bugs go undetected: unit tests catch logic bugs, integration tests catch API contract breaks, E2E tests catch user-visible regressions. Low coverage means large portions of code are never exercised.",
		recommendation:
			"Follow the testing pyramid: many unit tests, some integration tests, fewer E2E tests. Aim for >80% branch coverage. Every source file should have a corresponding test file. Use Playwright for E2E if you have a web frontend.",
	},
	secrets: {
		name: "secrets",
		label: "Secrets",
		category: "Security",
		priority: "critical",
		weight: 6,
		description:
			"Scans source files for hardcoded secrets: AWS keys, GitHub tokens, Stripe keys, OpenAI/Anthropic API keys, Google API keys, private keys, and generic secret patterns. Checks 13 regex patterns against every non-test source file.",
		risk: "Hardcoded secrets in source code are the #1 cause of credential leaks. Once pushed to Git, secrets are in the history forever — even if deleted in a later commit. Leaked API keys can be exploited within minutes by automated scanners.",
		recommendation:
			"Never hardcode secrets. Use environment variables or a secret manager (Bitwarden, AWS Secrets Manager, Cloudflare Secrets). If a secret was committed, rotate it immediately — deleting the file is not enough.",
	},
	security: {
		name: "security",
		label: "Security Patterns",
		category: "Security",
		priority: "critical",
		weight: 5,
		description:
			"Static analysis for 15 vulnerability patterns mapped to CWE (Common Weakness Enumeration) IDs. Covers: XSS (innerHTML, dangerouslySetInnerHTML, document.write), injection (eval, new Function, SQL template literals, command injection), weak crypto (Math.random for tokens, MD5/SHA1), prototype pollution, path traversal, SSRF, and missing security headers.",
		risk: "These patterns represent the most commonly exploited vulnerabilities in web applications (OWASP Top 10). A single XSS or injection vulnerability can lead to account takeover, data theft, or complete system compromise.",
		recommendation:
			"Replace innerHTML with textContent or DOM APIs. Never use eval(). Use parameterized queries for SQL. Use crypto.randomUUID() instead of Math.random() for tokens. Validate all user input before use in file paths or URLs.",
	},
	dependencies: {
		name: "dependencies",
		label: "Dependencies",
		category: "Security",
		priority: "high",
		weight: 5,
		description:
			"Runs npm/pnpm audit to find known vulnerabilities (CVEs) in dependencies. Also checks for outdated packages — major version gaps indicate potential security debt and breaking API changes.",
		risk: "Vulnerable dependencies are the most common attack vector for supply chain attacks. 84% of codebases contain at least one known vulnerability in their dependencies (Synopsys OSSRA 2024). Outdated major versions often have unpatched security issues.",
		recommendation:
			"Run 'pnpm audit' regularly and fix critical/high vulnerabilities immediately. Keep dependencies updated — use Dependabot or Renovate for automated PRs. Pin versions with a lockfile.",
	},
	architecture: {
		name: "architecture",
		label: "Architecture",
		category: "Architecture",
		priority: "high",
		weight: 6,
		description:
			"Analyzes the import graph to detect structural problems: circular dependencies, god modules (imported by >50% of files), orphan modules (dead code), high fan-out (importing too many modules), and connector modules (high coupling). Generates an SVG architecture diagram.",
		risk: "Circular dependencies create build order issues and make refactoring impossible without breaking changes. God modules become bottlenecks — any change ripples through the entire codebase. High coupling means you can't change one module without testing everything it touches.",
		recommendation:
			"Break circular deps by extracting shared types to a separate file. Split god modules by concern. Reduce fan-out by co-locating related code. Use dependency injection for loose coupling.",
	},
	confusion: {
		name: "confusion",
		label: "Confusion Index",
		category: "LLM Readiness",
		priority: "high",
		weight: 7,
		description:
			"Measures naming ambiguity that causes LLMs to misunderstand or edit the wrong code. Checks: file name confusability (Levenshtein distance + synonym detection), generic function/variable names, export name collisions across files, and ambiguous abbreviations.",
		risk: "GPT-4o drops 28.6 percentage points on code summarization when names are ambiguous (arXiv:2510.03178). LLMs editing similar-named files is the #1 reported failure mode in AI-assisted development. Generic names like process(), handle(), data cause models to misinterpret intent.",
		recommendation:
			"Use descriptive, unique names. Avoid synonym files (utils.ts + helpers.ts — pick one). Avoid generic exports. Disambiguate abbreviations (use 'authentication' not 'auth' if both auth meanings exist in the codebase).",
	},
	context: {
		name: "context",
		label: "Context Locality",
		category: "LLM Readiness",
		priority: "high",
		weight: 6,
		description:
			"Measures how self-contained code is for LLM consumption. Checks: token density per file, import count, circular dependencies, and context sinks (files that import many modules but export little). Based on the finding that LLMs lose 30%+ accuracy for information in the middle of long contexts.",
		risk: "Files over ~4000 tokens exceed the 'sweet spot' for LLM attention (Liu et al. 2023 'Lost in the Middle'). Circular dependencies create infinite loops in LLM code navigation. Heavy import chains force LLMs to load many files, burning context window budget (Chroma 'Context Rot' 2025).",
		recommendation:
			"Keep files under 400 lines / 4000 tokens. Limit imports to <15 per file. Break circular dependencies. Co-locate related code to reduce cross-file jumps.",
	},
	react: {
		name: "react",
		label: "React Patterns",
		category: "Quality",
		priority: "high",
		weight: 3,
		description:
			"Checks React-specific patterns: conditional hook calls (violates Rules of Hooks), missing key props in .map(), index as key, prop spreading on DOM elements, and excessive inline handlers.",
		risk: "Conditional hooks cause React to crash at runtime. Missing keys cause incorrect reconciliation — items can swap, duplicate, or lose state. Index keys break when lists are reordered or filtered.",
		recommendation:
			"Never call hooks inside conditions, loops, or nested functions. Always provide a unique, stable key in .map(). Avoid spreading unknown props onto DOM elements. Extract inline handlers for readability.",
	},
	accessibility: {
		name: "accessibility",
		label: "Accessibility",
		category: "Quality",
		priority: "high",
		weight: 4,
		description:
			"Checks common accessibility violations: images without alt text, click handlers on non-interactive elements without keyboard support, form controls without labels, autoFocus usage, positive tabIndex, and missing html lang attribute.",
		risk: "1 in 4 adults has a disability (CDC). Missing alt text makes images invisible to screen readers. Click-only divs exclude keyboard users. Unlabeled inputs are unusable with assistive technology. Missing lang attribute breaks screen reader pronunciation.",
		recommendation:
			"Add alt text to all images (use alt=\"\" for decorative). Use <button> for clickable elements, not <div onClick>. Label all form controls with <label>, aria-label, or aria-labelledby. Set lang on <html>.",
	},
	performance: {
		name: "performance",
		label: "Performance",
		category: "Architecture",
		priority: "medium",
		weight: 4,
		description:
			"Detects barrel imports that defeat tree-shaking, heavy dependencies with lighter alternatives, static imports of large libraries that could be lazy-loaded, and runtime CSS-in-JS overhead.",
		risk: "Barrel files (index.ts re-exports) prevent bundlers from tree-shaking unused code, bloating bundles by 2-10x. Heavy dependencies like moment.js add 300KB when date-fns does the same in 7KB. Static imports of visualization libraries delay initial page load.",
		recommendation:
			"Replace barrel re-exports with direct imports. Swap heavy deps for lighter alternatives. Use dynamic import() for large libraries only needed on interaction. Prefer zero-runtime CSS (Tailwind, CSS Modules) over styled-components.",
	},
	"doc-coherence": {
		name: "doc-coherence",
		label: "Doc Coherence",
		category: "AI Analysis",
		priority: "high",
		weight: 0,
		description:
			"LLM-powered analysis that detects contradictions between documentation and code. Finds stale README claims, incorrect JSDoc parameters, outdated CHANGELOG references, and comments that no longer match the implementation.",
		risk: "Stale documentation is worse than no documentation — it actively misleads developers and LLMs. When README says 'supports X' but the feature was removed, new contributors waste time. When JSDoc says a param is required but code treats it as optional, callers crash.",
		recommendation:
			"Enable doc-coherence with a VibeCode QA Pro subscription. The LLM scans all documentation against the actual code and surfaces contradictions with specific file references.",
		premium: true,
	},
	"code-coherence": {
		name: "code-coherence",
		label: "Code Coherence",
		category: "AI Analysis",
		priority: "high",
		weight: 0,
		description:
			"LLM-powered analysis that detects internal contradictions within the codebase itself. Finds inconsistent validation logic, conflicting defaults across modules, naming convention drift, dead config flags, and behavioral mismatches.",
		risk: "Incoherent codebases are the #1 source of 'it works on my machine' bugs. When module A validates email with regex and module B uses a different regex, some emails pass one and fail the other. When timeouts differ across modules, race conditions emerge under load.",
		recommendation:
			"Enable code-coherence with a VibeCode QA Pro subscription. The LLM analyzes cross-module patterns and surfaces behavioral contradictions that static analysis cannot detect.",
		premium: true,
	},
};

export function getCheckMeta(name: string): CheckMeta {
	return (
		CHECK_META[name] || {
			name,
			label: name,
			category: "Other",
			priority: "medium" as Priority,
			weight: 5,
			description: "",
			risk: "",
			recommendation: "",
		}
	);
}
