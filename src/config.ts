/** Load project-level vcqa configuration from .vcqa.json or package.json "vcqa" field. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface VcqaConfig {
	/** Disable or configure individual checks */
	checks?: Record<string, { enabled?: boolean }>;
	/** Extra glob patterns to ignore (added to built-in SKIP_DIRS) */
	ignore?: string[];
	/** Default fail-under threshold (overridden by --fail-under flag) */
	failUnder?: number;
}

const EMPTY: VcqaConfig = {};

export function loadConfig(cwd: string): VcqaConfig {
	// 1. Try .vcqa.json
	const configPath = join(cwd, ".vcqa.json");
	if (existsSync(configPath)) {
		try {
			const raw = JSON.parse(readFileSync(configPath, "utf-8"));
			return validate(raw);
		} catch {
			return EMPTY;
		}
	}

	// 2. Try "vcqa" field in package.json
	try {
		const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
		if (pkg.vcqa && typeof pkg.vcqa === "object") {
			return validate(pkg.vcqa);
		}
	} catch {
		/* no package.json or parse error */
	}

	return EMPTY;
}

/** Check if a specific check is enabled (default: true) */
export function isCheckEnabled(config: VcqaConfig, checkName: string): boolean {
	return config.checks?.[checkName]?.enabled !== false;
}

function validate(raw: Record<string, unknown>): VcqaConfig {
	const config: VcqaConfig = {};

	if (raw.checks && typeof raw.checks === "object") {
		config.checks = raw.checks as VcqaConfig["checks"];
	}
	if (Array.isArray(raw.ignore)) {
		config.ignore = raw.ignore.filter((p): p is string => typeof p === "string");
	}
	if (typeof raw.failUnder === "number") {
		config.failUnder = raw.failUnder;
	}

	return config;
}
