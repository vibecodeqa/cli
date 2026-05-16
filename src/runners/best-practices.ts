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
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

export function runBestPractices(cwd: string): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	let practices = 0;
	let followed = 0;

	const has = (f: string) => existsSync(join(cwd, f));
	const read = (f: string) => { try { return readFileSync(join(cwd, f), "utf-8"); } catch { return ""; } };

	// ── 1. CI/CD Best Practices ──

	// Check for GitHub Actions workflows
	const hasWorkflows = has(".github/workflows");
	practices++;
	if (hasWorkflows) {
		followed++;
		const workflows = readdirSync(join(cwd, ".github/workflows")).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"));

		for (const wf of workflows) {
			const content = read(`.github/workflows/${wf}`);

			// Check: actions pinned to SHA (not @v4, @main)
			const actionUses = content.match(/uses:\s*([^\n]+)/g) || [];
			const unpinned = actionUses.filter(u => !u.includes("@") || (!u.match(/@[a-f0-9]{40}/) && !u.includes("@sha")));
			// Only flag third-party actions (not actions/*)
			const unpinnedThirdParty = unpinned.filter(u => !u.includes("actions/") && !u.includes("pnpm/"));
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

	// ── 2. Supply Chain ──

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
		issues.push({ severity: "info", message: "No engine constraints (engines in package.json or .nvmrc) — Node version not pinned", rule: "pin-node-version" });
	}

	// npm provenance / package.json has repository field
	if (pkg) {
		practices++;
		if (pkg.includes('"repository"')) {
			followed++;
		} else {
			issues.push({ severity: "info", message: "package.json missing repository field — provenance attestation won't link to source", rule: "repository-field" });
		}
	}

	// ── 3. Repo Hygiene ──

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
		issues.push({ severity: "info", message: "No CONTRIBUTING.md — onboarding is harder for new contributors", rule: "contributing-guide" });
	}

	// ── 4. Developer Experience ──

	// .env.example
	practices++;
	const hasEnvFiles = has(".env") || has(".env.local") || has(".env.development");
	if (hasEnvFiles && !has(".env.example")) {
		issues.push({ severity: "info", message: "Has .env files but no .env.example — new developers won't know what vars are needed", rule: "env-example" });
	} else {
		followed++;
	}

	// Pre-commit hooks (husky, lefthook, lint-staged)
	practices++;
	const deps = readDeps(cwd);
	if (deps.husky || deps.lefthook || deps["lint-staged"] || has(".husky") || has(".lefthook.yml")) {
		followed++;
	} else {
		issues.push({ severity: "info", message: "No pre-commit hooks (husky/lefthook) — lint/format not enforced before commit", rule: "pre-commit-hooks" });
	}

	// Renovate/Dependabot for automated dependency updates
	practices++;
	if (has(".github/dependabot.yml") || has("renovate.json") || has(".renovaterc") || has(".renovaterc.json")) {
		followed++;
	} else {
		issues.push({ severity: "info", message: "No Dependabot/Renovate — dependency updates are manual and often forgotten", rule: "automated-deps" });
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
