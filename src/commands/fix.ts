/** vcqa fix — auto-fix + AI-powered fixing. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aiFixIssues, collectFixableIssues } from "../ai-fix.js";
import { scan } from "../core.js";
import { detectStack } from "../detect.js";
import { gradeFromScore } from "../types.js";
import { suggestFix, validateCwd } from "./shared.js";

export async function runFix(cwd: string, opts: { ai?: boolean; dryRun?: boolean; checkFilter?: string } = {}): Promise<void> {
	console.log("");
	console.log(`  \x1b[1m\x1b[38;5;141mvcqa fix${opts.ai ? " --ai" : ""}${opts.dryRun ? " --dry-run" : ""}${opts.checkFilter ? ` --check ${opts.checkFilter}` : ""}\x1b[0m`);
	console.log(`  \x1b[2m${cwd}\x1b[0m`);
	console.log("");

	validateCwd(cwd);

	const stack = detectStack(cwd);
	let fixed = 0;

	// 0. Auto-fix structure issues (missing files)
	if (!existsSync(join(cwd, ".gitignore"))) {
		writeFileSync(join(cwd, ".gitignore"), "node_modules\ndist\n.vibe-check\ncoverage\n.env\n.env.local\n");
		console.log("  \x1b[32m\u2713 Created .gitignore\x1b[0m");
		fixed++;
	}

	if (existsSync(join(cwd, ".gitignore"))) {
		const gi = readFileSync(join(cwd, ".gitignore"), "utf-8");
		if (!gi.includes(".vibe-check")) {
			writeFileSync(join(cwd, ".gitignore"), gi.trimEnd() + "\n.vibe-check/\n");
			console.log("  \x1b[32m\u2713 Added .vibe-check/ to .gitignore\x1b[0m");
			fixed++;
		}
	}

	const tsconfigPath = join(cwd, "tsconfig.json");
	if (existsSync(tsconfigPath)) {
		try {
			const raw = readFileSync(tsconfigPath, "utf-8");
			const tsconfig = JSON.parse(raw);
			if (!tsconfig.compilerOptions?.strict) {
				tsconfig.compilerOptions = { ...tsconfig.compilerOptions, strict: true };
				writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
				console.log('  \x1b[32m\u2713 Enabled "strict": true in tsconfig.json\x1b[0m');
				fixed++;
			}
		} catch { /* can't parse tsconfig */ }
	}

	// 1. Run linter auto-fix
	if (stack.linter === "biome") {
		console.log("  \x1b[1mFormatting with Biome...\x1b[0m");
		const { execSync } = await import("node:child_process");
		try {
			execSync("npx biome check --write .", { cwd, stdio: "inherit", timeout: 30_000 });
			fixed++;
		} catch {
			console.log("  \x1b[33mBiome had issues (some may be unfixable)\x1b[0m");
		}
	} else if (stack.linter === "eslint") {
		console.log("  \x1b[1mFixing with ESLint...\x1b[0m");
		const { execSync } = await import("node:child_process");
		try {
			execSync("npx eslint --fix src/", { cwd, stdio: "inherit", timeout: 30_000 });
			fixed++;
		} catch {
			console.log("  \x1b[33mESLint had issues (some may be unfixable)\x1b[0m");
		}
	}

	// 2. Scan for remaining issues
	console.log("");
	console.log("  \x1b[1mScanning for remaining issues...\x1b[0m");
	console.log("");

	const report = await scan(cwd, { skipTests: true });
	const { checks } = report;
	const score = report.score;

	// AI-powered fix mode
	if (opts.ai) {
		const aiIssues = collectFixableIssues(checks, suggestFix, opts.checkFilter);
		if (aiIssues.length === 0) {
			console.log("  \x1b[2mNo fixable issues found.\x1b[0m");
		} else {
			console.log(`  \x1b[1mAI fixing ${Math.min(aiIssues.length, 10)} issues${opts.dryRun ? " (dry run)" : ""}...\x1b[0m`);
			console.log("");
			const results = await aiFixIssues(cwd, aiIssues, { dryRun: opts.dryRun || false });
			const applied = results.filter((r) => r.applied).length;

			if (applied > 0) {
				console.log("");
				console.log("  \x1b[1mRe-scanning...\x1b[0m");
				const reReport = await scan(cwd, { skipTests: true });
				const delta = reReport.score - score;
				console.log(`  Score: \x1b[${reReport.score >= 75 ? "32" : reReport.score >= 60 ? "33" : "31"}m${reReport.grade} ${reReport.score}/100\x1b[0m${delta > 0 ? ` \x1b[32m(+${delta})\x1b[0m` : ""}`);
				console.log(`  \x1b[32m${applied} AI fix(es) applied.\x1b[0m Re-run \x1b[1mnpx @vibecodeqa/cli\x1b[0m for full report.`);
			} else {
				const grade = gradeFromScore(score);
				console.log(`\n  Score: \x1b[${score >= 75 ? "32" : score >= 60 ? "33" : "31"}m${grade} ${score}/100\x1b[0m`);
				if (opts.dryRun) console.log("  \x1b[2mDry run — no files modified. Remove --dry-run to apply.\x1b[0m");
			}
		}
		console.log("");
		return;
	}

	// Non-AI mode: show fix suggestions
	const fixable: { check: string; file: string; line: number; message: string; fix: string }[] = [];
	for (const c of checks) {
		for (const iss of c.issues) {
			if (!iss.file || typeof iss.file !== "string" || !iss.line) continue;
			const fix = suggestFix(c.name, iss.rule || "", iss.message);
			if (fix) fixable.push({ check: c.name, file: iss.file, line: iss.line, message: iss.message, fix });
		}
	}

	const top = fixable.slice(0, 10);
	if (top.length > 0) {
		console.log(`  \x1b[1m${top.length} issues with fix suggestions:\x1b[0m`);
		console.log("");
		for (const f of top) {
			console.log(`  \x1b[2m${f.file}:${f.line}\x1b[0m`);
			console.log(`  ${f.message}`);
			console.log(`  \x1b[32mFix: ${f.fix}\x1b[0m`);
			console.log("");
		}
	}

	const grade = gradeFromScore(score);
	console.log(`  Score after fix: \x1b[${score >= 75 ? "32" : score >= 60 ? "33" : "31"}m${grade} ${score}/100\x1b[0m`);
	if (fixed > 0) console.log(`  \x1b[32m${fixed} auto-fix(es) applied.\x1b[0m Re-run \x1b[1mnpx @vibecodeqa/cli\x1b[0m for full report.`);
	console.log("");
}
