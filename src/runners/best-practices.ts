/** Best Practices advisory — checks for industry-standard CI/CD, repo hygiene, and supply chain practices.
 *
 * Unlike other checks, this doesn't penalize harshly — it advises.
 * Issues are "info" and "warning" severity, not errors.
 *
 * Categories:
 *   1. CI/CD — workflows, OIDC, pinned actions, permissions
 *   2. Supply chain — lockfile, provenance, dependency pinning
 *   3. Repo hygiene — branch protection signals, CODEOWNERS, security policy
 *   4. Developer experience — contributing guide, .env.example, scripts
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readDeps } from "../fs-utils.js";
import type { CheckResult, Issue, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";

type HasFn = (f: string) => boolean;
type ReadFn = (f: string) => string;
interface CategoryResult {
	practices: number;
	followed: number;
	issues: Issue[];
}

function checkCICD(cwd: string, has: HasFn, read: ReadFn): CategoryResult {
	const issues: Issue[] = [];
	let practices = 0;
	let followed = 0;

	// Check for GitHub Actions workflows
	const hasWorkflows = has(".github/workflows");
	practices++;
	if (hasWorkflows) {
		followed++;
		const workflows = readdirSync(join(cwd, ".github/workflows")).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

		for (const wf of workflows) {
			const content = read(`.github/workflows/${wf}`);

			// Check: actions pinned to SHA (not @v4, @main)
			const actionUses = content.match(/uses:\s*([^\n]+)/g) || [];
			const unpinned = actionUses.filter((u) => !u.includes("@") || (!u.match(/@[a-f0-9]{40}/) && !u.includes("@sha")));
			// Only flag third-party actions (not actions/*)
			const unpinnedThirdParty = unpinned.filter((u) => !u.includes("actions/") && !u.includes("pnpm/"));
			if (unpinnedThirdParty.length > 0) {
				issues.push({
					severity: "info",
					message: `${wf}: ${unpinnedThirdParty.length} third-party actions not pinned to SHA — vulnerable to supply chain attacks`,
					file: `.github/workflows/${wf}`,
					rule: "pin-actions-to-sha",
				});
			}

			// Check: minimal permissions
			practices++;
			if (content.includes("permissions:")) {
				followed++;
			} else {
				issues.push({
					severity: "warning",
					message: `${wf}: no explicit permissions block — defaults to read-write (overly permissive)`,
					file: `.github/workflows/${wf}`,
					rule: "explicit-permissions",
				});
			}

			// Check: OIDC for publishing (no long-lived tokens)
			if (content.includes("publish") || content.includes("deploy")) {
				practices++;
				if (content.includes("id-token: write")) {
					followed++;
				} else if (content.includes("NPM_TOKEN") || content.includes("DEPLOY_TOKEN") || content.includes("AWS_ACCESS_KEY")) {
					issues.push({
						severity: "info",
						message: `${wf}: uses long-lived secret tokens — consider OIDC trusted publishing/workload identity`,
						file: `.github/workflows/${wf}`,
						rule: "prefer-oidc",
					});
				}
			}

			// Check: frozen lockfile in CI
			practices++;
			if (content.includes("--frozen-lockfile") || content.includes("--ci") || content.includes("npm ci")) {
				followed++;
			} else if (content.includes("install")) {
				issues.push({
					severity: "info",
					message: `${wf}: CI install without frozen lockfile — builds may not be reproducible`,
					file: `.github/workflows/${wf}`,
					rule: "frozen-lockfile-ci",
				});
			}
		}
	} else {
		issues.push({
			severity: "warning",
			message: "No .github/workflows/ — no CI/CD automation. Add GitHub Actions for automated testing and deployment.",
			rule: "no-ci",
		});
	}

	return { practices, followed, issues };
}

function checkSupplyChain(has: HasFn, read: ReadFn): CategoryResult {
	const issues: Issue[] = [];
	let practices = 0;
	let followed = 0;

	// Lockfile committed
	practices++;
	const hasLockfile = has("pnpm-lock.yaml") || has("package-lock.json") || has("yarn.lock") || has("bun.lockb") || has("pubspec.lock");
	if (hasLockfile) {
		followed++;
	} else {
		issues.push({ severity: "warning", message: "No lockfile committed — dependency versions not deterministic", rule: "lockfile" });
	}

	// .npmrc or package.json engine constraints
	practices++;
	const pkg = read("package.json");
	if (pkg.includes('"engines"') || has(".nvmrc") || has(".node-version") || has(".tool-versions")) {
		followed++;
	} else {
		issues.push({
			severity: "info",
			message: "No engine constraints (engines in package.json or .nvmrc) — Node version not pinned",
			rule: "pin-node-version",
		});
	}

	// npm provenance / package.json has repository field
	if (pkg) {
		practices++;
		if (pkg.includes('"repository"')) {
			followed++;
		} else {
			issues.push({
				severity: "info",
				message: "package.json missing repository field — provenance attestation won't link to source",
				rule: "repository-field",
			});
		}
	}

	return { practices, followed, issues };
}

function checkRepoHygiene(has: HasFn): CategoryResult {
	const issues: Issue[] = [];
	let practices = 0;
	let followed = 0;

	// SECURITY.md or security policy
	practices++;
	if (has("SECURITY.md") || has(".github/SECURITY.md")) {
		followed++;
	} else {
		issues.push({ severity: "info", message: "No SECURITY.md — users don't know how to report vulnerabilities", rule: "security-policy" });
	}

	// CODEOWNERS
	practices++;
	if (has("CODEOWNERS") || has(".github/CODEOWNERS") || has("docs/CODEOWNERS")) {
		followed++;
	} else {
		issues.push({ severity: "info", message: "No CODEOWNERS file — no mandatory reviewers for critical paths", rule: "codeowners" });
	}

	// Branch protection signal: require PR (check for documented merge strategy)
	practices++;
	if (has("CONTRIBUTING.md") || has(".github/CONTRIBUTING.md")) {
		followed++;
	} else {
		issues.push({
			severity: "info",
			message: "No CONTRIBUTING.md — onboarding is harder for new contributors",
			rule: "contributing-guide",
		});
	}

	return { practices, followed, issues };
}

function checkDevExperience(cwd: string, has: HasFn): CategoryResult {
	const issues: Issue[] = [];
	let practices = 0;
	let followed = 0;

	// .env.example
	practices++;
	const hasEnvFiles = has(".env") || has(".env.local") || has(".env.development");
	if (hasEnvFiles && !has(".env.example")) {
		issues.push({
			severity: "info",
			message: "Has .env files but no .env.example — new developers won't know what vars are needed",
			rule: "env-example",
		});
	} else {
		followed++;
	}

	// Pre-commit hooks (husky, lefthook, lint-staged)
	practices++;
	const deps = readDeps(cwd);
	if (deps.husky || deps.lefthook || deps["lint-staged"] || has(".husky") || has(".lefthook.yml")) {
		followed++;
	} else {
		issues.push({
			severity: "info",
			message: "No pre-commit hooks (husky/lefthook) — lint/format not enforced before commit",
			rule: "pre-commit-hooks",
		});
	}

	// Renovate/Dependabot for automated dependency updates
	practices++;
	if (has(".github/dependabot.yml") || has("renovate.json") || has(".renovaterc") || has(".renovaterc.json")) {
		followed++;
	} else {
		issues.push({
			severity: "info",
			message: "No Dependabot/Renovate — dependency updates are manual and often forgotten",
			rule: "automated-deps",
		});
	}

	return { practices, followed, issues };
}

function checkCodeQualityTooling(cwd: string, has: HasFn, read: ReadFn, workspace?: WorkspaceInfo): CategoryResult {
	const issues: Issue[] = [];
	let practices = 0;
	let followed = 0;
	const deps = readDeps(cwd);

	// Linter configured — check root config, deps, workspace packages, or CI
	practices++;
	const hasRootLinter =
		has("biome.json") ||
		has("biome.jsonc") ||
		has(".eslintrc.json") ||
		has(".eslintrc.js") ||
		has("eslint.config.js") ||
		has("eslint.config.ts") ||
		has("eslint.config.mjs") ||
		has("analysis_options.yaml");
	const hasLinterDep = !!(deps["@biomejs/biome"] || deps.eslint);
	const hasPackageLinter = workspace?.isMonorepo && workspace.packages.some((p) => p.hasLinter);

	if (hasRootLinter || hasLinterDep || hasPackageLinter) {
		followed++;
	} else {
		issues.push({
			severity: "warning",
			message: "No linter config (ESLint/Biome/dart analyze) — code style not enforced",
			rule: "linter-config",
		});
	}

	// Formatter configured
	practices++;
	if (
		has("biome.json") ||
		has("biome.jsonc") ||
		has(".prettierrc") ||
		has(".prettierrc.json") ||
		has("prettier.config.js") ||
		has(".editorconfig") ||
		deps["@biomejs/biome"] ||
		deps.prettier
	) {
		followed++;
	} else {
		issues.push({
			severity: "info",
			message: "No formatter config (Prettier/Biome/.editorconfig) — inconsistent code formatting",
			rule: "formatter-config",
		});
	}

	// TypeScript strict mode
	practices++;
	const tsconfig = read("tsconfig.json") || read("tsconfig.base.json");
	if (!tsconfig || tsconfig.includes('"strict": true') || tsconfig.includes('"strict":true')) {
		followed++;
	} else {
		issues.push({
			severity: "info",
			message: "TypeScript strict mode not enabled — allows implicit any and null errors",
			rule: "ts-strict-mode",
		});
	}

	return { practices, followed, issues };
}

function checkTesting(has: HasFn, read: ReadFn): CategoryResult {
	const issues: Issue[] = [];
	let practices = 0;
	let followed = 0;

	const pkg = read("package.json");

	// Test script exists
	practices++;
	if (pkg.includes('"test"') || has("pubspec.yaml")) {
		followed++;
	} else {
		issues.push({ severity: "warning", message: "No test script in package.json — testing not configured", rule: "test-script" });
	}

	// Coverage configured
	practices++;
	if (pkg.includes("coverage") || has("vitest.config.ts") || has("jest.config.ts") || has("jest.config.js")) {
		followed++;
	} else {
		issues.push({
			severity: "info",
			message: "No test coverage configuration — coverage thresholds not enforced",
			rule: "coverage-config",
		});
	}

	return { practices, followed, issues };
}

function checkDocker(has: HasFn, read: ReadFn): CategoryResult {
	const issues: Issue[] = [];
	let practices = 0;
	let followed = 0;

	// Dockerfile best practices (if Docker is used)
	if (has("Dockerfile") || has("docker-compose.yml") || has("docker-compose.yaml")) {
		practices++;
		const dockerfile = read("Dockerfile");
		if (dockerfile.includes("FROM") && !dockerfile.includes("latest")) {
			followed++;
		} else if (dockerfile.includes(":latest")) {
			issues.push({
				severity: "warning",
				message: "Dockerfile uses :latest tag — pin to a specific version for reproducible builds",
				rule: "docker-pin-version",
			});
		} else {
			followed++;
		}

		// Multi-stage build
		practices++;
		const fromCount = (dockerfile.match(/^FROM /gm) || []).length;
		if (fromCount >= 2) {
			followed++;
		} else if (dockerfile.length > 100) {
			issues.push({
				severity: "info",
				message: "Dockerfile is single-stage — consider multi-stage to reduce image size",
				rule: "docker-multi-stage",
			});
		} else {
			followed++;
		}

		// .dockerignore
		practices++;
		if (has(".dockerignore")) {
			followed++;
		} else {
			issues.push({
				severity: "info",
				message: "No .dockerignore — node_modules and build artifacts will bloat Docker image",
				rule: "dockerignore",
			});
		}
	}

	return { practices, followed, issues };
}

function checkGitPractices(cwd: string, has: HasFn, read: ReadFn): CategoryResult {
	const issues: Issue[] = [];
	let practices = 0;
	let followed = 0;

	const deps = readDeps(cwd);

	// .gitignore is comprehensive
	practices++;
	const gitignore = read(".gitignore");
	if (gitignore.includes("node_modules") || gitignore.includes(".dart_tool") || gitignore.includes("build/")) {
		followed++;
	} else if (gitignore) {
		issues.push({
			severity: "info",
			message: ".gitignore exists but may be incomplete — ensure build artifacts are excluded",
			rule: "gitignore-complete",
		});
	} else {
		followed++; // no gitignore = handled by structure check
	}

	// Conventional commits signal (commitlint or similar)
	practices++;
	if (deps.commitlint || deps["@commitlint/cli"] || has("commitlint.config.js") || has(".commitlintrc.json") || has(".changeset")) {
		followed++;
	} else {
		issues.push({
			severity: "info",
			message: "No commit convention enforcement (commitlint/changesets) — changelog generation is manual",
			rule: "conventional-commits",
		});
	}

	return { practices, followed, issues };
}

function checkMonitoring(cwd: string): CategoryResult {
	const issues: Issue[] = [];
	let practices = 0;
	let followed = 0;

	const deps = readDeps(cwd);

	// Error tracking (Sentry, Bugsnag, etc.) — only for apps/servers, not CLI tools
	const isApp = deps.react || deps.vue || deps.svelte || deps.express || deps.fastify || deps.hono || deps.next || deps.nuxt;
	if (isApp) {
		practices++;
		if (deps["@sentry/node"] || deps["@sentry/react"] || deps["@sentry/browser"] || deps.bugsnag || deps["@bugsnag/js"]) {
			followed++;
		} else {
			issues.push({
				severity: "info",
				message: "No error tracking (Sentry/Bugsnag) — production errors may go unnoticed",
				rule: "error-tracking",
			});
		}
	}

	return { practices, followed, issues };
}

function checkAPIConfig(cwd: string, read: ReadFn): CategoryResult {
	const issues: Issue[] = [];
	let practices = 0;
	let followed = 0;

	const deps = readDeps(cwd);
	const pkg = read("package.json");

	// Environment validation (zod, joi, envalid)
	practices++;
	if (deps.zod || deps.joi || deps.envalid || deps["@t3-oss/env-core"] || deps["@t3-oss/env-nextjs"]) {
		followed++;
	} else {
		// Check for process.env usage in common entry points (root and workspace packages)
		const entryFiles = ["src/index.ts", "src/main.ts", "src/server.ts", "src/app.ts"];
		const hasEnvUsage = pkg.includes("process.env") || entryFiles.some((f) => read(f).includes("process.env"));
		if (hasEnvUsage) {
			issues.push({
				severity: "info",
				message: "Uses env vars but no validation library (zod/envalid) — missing vars crash at runtime",
				rule: "env-validation",
			});
		} else {
			followed++;
		}
	}

	return { practices, followed, issues };
}

export function runBestPractices(cwd: string, workspace?: WorkspaceInfo): CheckResult {
	const start = Date.now();

	const has: HasFn = (f: string) => existsSync(join(cwd, f));
	const read: ReadFn = (f: string) => {
		try {
			return readFileSync(join(cwd, f), "utf-8");
		} catch {
			return "";
		}
	};

	const categories = [
		checkCICD(cwd, has, read),
		checkSupplyChain(has, read),
		checkRepoHygiene(has),
		checkDevExperience(cwd, has),
		checkCodeQualityTooling(cwd, has, read, workspace),
		checkTesting(has, read),
		checkDocker(has, read),
		checkGitPractices(cwd, has, read),
		checkMonitoring(cwd),
		checkAPIConfig(cwd, read),
	];

	let practices = 0;
	let followed = 0;
	const issues: Issue[] = [];

	for (const cat of categories) {
		practices += cat.practices;
		followed += cat.followed;
		issues.push(...cat.issues);
	}

	// ── Score ──
	const pct = practices > 0 ? Math.round((followed / practices) * 100) : 100;
	const score = pct;

	return {
		name: "best-practices",
		score,
		grade: gradeFromScore(score),
		details: {
			practicesChecked: practices,
			practicesFollowed: followed,
			adherence: `${pct}%`,
		},
		issues,
		duration: Date.now() - start,
	};
}
