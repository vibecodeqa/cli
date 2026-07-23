/** Dependency health — vulnerabilities, outdated packages, license compliance. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
		const score = Math.max(0, Math.min(100, 100 - Math.min(30, majorOutdated * 3)));
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
	const majorOutdatedPkgs: string[] = [];
	try {
		const outdated = JSON.parse(outdatedResult.stdout);
		// npm/pnpm format: object keyed by package name
		for (const [name, info] of Object.entries(outdated) as [string, any][]) {
			outdatedCount++;
			const current = info.current || info.version || "";
			const latest = info.latest || "";
			if (current && latest && current.split(".")[0] !== latest.split(".")[0]) {
				majorOutdated++;
				majorOutdatedPkgs.push(`${name} ${current} → ${latest}`);
			}
		}
	} catch {
		/* no outdated data */
	}

	if (majorOutdated > 0) {
		issues.push({
			severity: "warning",
			message: `${majorOutdated} packages behind by a major version`,
			rule: "major-outdated",
		});
		for (const pkg of majorOutdatedPkgs.slice(0, 5)) {
			issues.push({ severity: "info", message: pkg, rule: "outdated-package" });
		}
		if (majorOutdatedPkgs.length > 5) {
			issues.push({ severity: "info", message: `...and ${majorOutdatedPkgs.length - 5} more`, rule: "outdated-package" });
		}
	}

	// ── License compliance audit ──
	const licenseAudit = auditLicenses(cwd);
	let copyleftCount = 0;
	let unknownLicenseCount = 0;
	if (licenseAudit) {
		for (const finding of licenseAudit) {
			if (finding.type === "copyleft") {
				copyleftCount++;
				issues.push({
					severity: "warning",
					message: `${finding.name}@${finding.version}: ${finding.license} — copyleft license, may require source disclosure`,
					rule: "copyleft-license",
				});
			} else if (finding.type === "unknown") {
				unknownLicenseCount++;
				issues.push({
					severity: "info",
					message: `${finding.name}@${finding.version}: license unknown — verify manually`,
					rule: "unknown-license",
				});
			}
		}
		if (copyleftCount > 5) {
			// Truncate to avoid noise
			const excess = copyleftCount - 5;
			issues.push({ severity: "info", message: `...and ${excess} more copyleft dependencies`, rule: "copyleft-license" });
		}
	}

	// Score: harsh on critical/high, with diminishing returns for many vulns
	const critPenalty = Math.min(50, vulnCritical * 20);
	const highPenalty = Math.min(30, vulnHigh * 10);
	const modPenalty = Math.min(15, vulnModerate * 3);
	const outdatedPenalty = Math.min(10, majorOutdated);
	const licensePenalty = Math.min(15, copyleftCount * 5);
	const score = Math.max(0, Math.min(100, Math.round(100 - critPenalty - highPenalty - modPenalty - outdatedPenalty - licensePenalty)));

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
			licenses: licenseAudit ? { copyleft: copyleftCount, unknown: unknownLicenseCount } : undefined,
		},
		issues,
		duration: Date.now() - start,
	};
}

// ── License compliance ──

const COPYLEFT_LICENSES = new Set([
	"GPL-2.0",
	"GPL-2.0-only",
	"GPL-2.0-or-later",
	"GPL-3.0",
	"GPL-3.0-only",
	"GPL-3.0-or-later",
	"AGPL-1.0",
	"AGPL-3.0",
	"AGPL-3.0-only",
	"AGPL-3.0-or-later",
	"LGPL-2.0",
	"LGPL-2.1",
	"LGPL-3.0",
	"MPL-2.0",
	"EUPL-1.1",
	"EUPL-1.2",
	"SSPL-1.0",
	"CPAL-1.0",
	"OSL-3.0",
]);

const PERMISSIVE_LICENSES = new Set([
	"MIT",
	"ISC",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"Apache-2.0",
	"CC0-1.0",
	"Unlicense",
	"0BSD",
	"BlueOak-1.0.0",
	"Zlib",
]);

interface LicenseFinding {
	name: string;
	version: string;
	license: string;
	type: "copyleft" | "unknown";
}

function auditLicenses(cwd: string): LicenseFinding[] | null {
	const nodeModules = join(cwd, "node_modules");
	if (!existsSync(nodeModules)) return null;

	const findings: LicenseFinding[] = [];
	const seen = new Set<string>();

	// Scan top-level node_modules (direct deps)
	let entries: string[];
	try {
		entries = readdirSync(nodeModules);
	} catch {
		return null;
	}

	for (const entry of entries) {
		if (entry.startsWith(".")) continue;

		// Handle scoped packages (@org/pkg)
		if (entry.startsWith("@")) {
			try {
				for (const sub of readdirSync(join(nodeModules, entry))) {
					checkPackageLicense(join(nodeModules, entry, sub), `${entry}/${sub}`, findings, seen);
				}
			} catch {
				/* skip */
			}
		} else {
			checkPackageLicense(join(nodeModules, entry), entry, findings, seen);
		}
	}

	return findings;
}

function checkPackageLicense(pkgDir: string, name: string, findings: LicenseFinding[], seen: Set<string>): void {
	if (seen.has(name)) return;
	seen.add(name);

	const pkgJsonPath = join(pkgDir, "package.json");
	if (!existsSync(pkgJsonPath)) return;

	try {
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
		const version = pkg.version || "?";
		let license = pkg.license || "";

		// Handle { type: "MIT" } format
		if (typeof license === "object" && license.type) license = license.type;
		if (!license && pkg.licenses) {
			// Handle array format [{ type: "MIT" }]
			license = Array.isArray(pkg.licenses) ? pkg.licenses.map((l: any) => l.type || l).join(" OR ") : "";
		}

		if (!license || license === "UNLICENSED") return; // private package
		if (PERMISSIVE_LICENSES.has(license)) return; // all good

		// Check for copyleft
		const normalized = license.replace(/\s+/g, "");
		if (COPYLEFT_LICENSES.has(normalized) || /GPL|AGPL|SSPL/i.test(license)) {
			findings.push({ name, version, license, type: "copyleft" });
		} else if (!PERMISSIVE_LICENSES.has(normalized) && !/^\(.*\)$/.test(license)) {
			// Unknown/uncommon license (skip SPDX expressions like "(MIT OR Apache-2.0)")
			findings.push({ name, version, license, type: "unknown" });
		}
	} catch {
		/* can't read package.json */
	}
}
