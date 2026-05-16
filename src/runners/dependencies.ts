/** Dependency health — vulnerabilities, outdated packages. */

import type { CheckResult, Issue, StackInfo } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

export function runDependencies(cwd: string, stack: StackInfo): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const pm = stack.packageManager;

	// Dart/Flutter: skip npm audit, just check pubspec for outdated
	if (pm === "pub") {
		const outdatedResult = run("dart pub outdated --json 2>/dev/null || true", cwd);
		let outdatedCount = 0;
		let majorOutdated = 0;
		try {
			const data = JSON.parse(outdatedResult.stdout);
			for (const pkg of data.packages || []) {
				if (pkg.current?.version && pkg.latest?.version && pkg.current.version !== pkg.latest.version) {
					outdatedCount++;
					if (pkg.current.version.split(".")[0] !== pkg.latest.version.split(".")[0]) majorOutdated++;
				}
			}
		} catch {
			/* parse failed */
		}
		if (majorOutdated > 0) issues.push({ severity: "warning", message: `${majorOutdated} packages behind by a major version` });
		const score = Math.max(0, Math.min(100, 100 - majorOutdated));
		return {
			name: "dependencies",
			score,
			grade: gradeFromScore(score),
			details: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 }, outdated: outdatedCount, majorOutdated },
			issues,
			duration: Date.now() - start,
		};
	}

	// Vulnerability audit
	const auditCmd = pm === "pnpm" ? "pnpm audit --json" : pm === "yarn" ? "yarn audit --json" : "npm audit --json";
	const auditResult = run(`${auditCmd} 2>/dev/null || true`, cwd);
	let vulnCritical = 0,
		vulnHigh = 0,
		vulnModerate = 0,
		vulnLow = 0;

	try {
		const audit = JSON.parse(auditResult.stdout);
		// npm audit format
		if (audit.metadata?.vulnerabilities) {
			const v = audit.metadata.vulnerabilities;
			vulnCritical = v.critical || 0;
			vulnHigh = v.high || 0;
			vulnModerate = v.moderate || 0;
			vulnLow = v.low || 0;
		}
		// pnpm audit format
		if (audit.advisories) {
			for (const adv of Object.values(audit.advisories) as any[]) {
				if (adv.severity === "critical") vulnCritical++;
				else if (adv.severity === "high") vulnHigh++;
				else if (adv.severity === "moderate") vulnModerate++;
				else vulnLow++;
			}
		}
	} catch {
		/* audit parse failed — might be clean */
	}

	if (vulnCritical > 0)
		issues.push({
			severity: "error",
			message: `${vulnCritical} critical vulnerabilities`,
		});
	if (vulnHigh > 0)
		issues.push({
			severity: "error",
			message: `${vulnHigh} high vulnerabilities`,
		});
	if (vulnModerate > 0)
		issues.push({
			severity: "warning",
			message: `${vulnModerate} moderate vulnerabilities`,
		});

	// Outdated check
	const outdatedCmd = pm === "pnpm" ? "pnpm outdated --json" : "npm outdated --json";
	const outdatedResult = run(`${outdatedCmd} 2>/dev/null || true`, cwd);
	let outdatedCount = 0;
	let majorOutdated = 0;
	try {
		const outdated = JSON.parse(outdatedResult.stdout);
		// npm/pnpm format: object keyed by package name
		for (const [, info] of Object.entries(outdated) as [string, any][]) {
			outdatedCount++;
			const current = info.current || info.version || "";
			const latest = info.latest || "";
			if (current && latest && current.split(".")[0] !== latest.split(".")[0]) {
				majorOutdated++;
			}
		}
	} catch {
		/* no outdated data */
	}

	if (majorOutdated > 0)
		issues.push({
			severity: "warning",
			message: `${majorOutdated} packages behind by a major version`,
		});

	// Score: -25 per critical, -15 per high, -5 per moderate, -1 per major outdated
	const score = Math.max(0, Math.min(100, 100 - vulnCritical * 25 - vulnHigh * 15 - vulnModerate * 5 - majorOutdated * 1));

	return {
		name: "dependencies",
		score,
		grade: gradeFromScore(score),
		details: {
			vulnerabilities: {
				critical: vulnCritical,
				high: vulnHigh,
				moderate: vulnModerate,
				low: vulnLow,
			},
			outdated: outdatedCount,
			majorOutdated,
		},
		issues,
		duration: Date.now() - start,
	};
}
