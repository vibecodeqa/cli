/** vcqa fix — auto-fix + AI-powered fixing with delta report. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aiFixIssues, collectFixableIssues } from "../ai-fix.js";
import { scan } from "../core.js";
import { computeDelta, formatDeltaMarkdown } from "../delta.js";
import { detectStack } from "../detect.js";
import { suggestFix, validateCwd } from "./shared.js";

export async function runFix(cwd: string, opts: { ai?: boolean; dryRun?: boolean; checkFilter?: string } = {}): Promise<void> {
	console.log("");
	console.log(`  \x1b[1m\x1b[38;5;141mvcqa fix${opts.ai ? " --ai" : ""}${opts.dryRun ? " --dry-run" : ""}${opts.checkFilter ? ` --check ${opts.checkFilter}` : ""}\x1b[0m`);
	console.log(`  \x1b[2m${cwd}\x1b[0m`);
	console.log("");

	validateCwd(cwd);

	// 0. Baseline scan (before fixes)
	console.log("  \x1b[1mBaseline scan...\x1b[0m");
	const beforeReport = await scan(cwd, { skipTests: true });
	console.log(`  \x1b[2mBaseline: ${beforeReport.grade} ${beforeReport.score}/100\x1b[0m`);
	console.log("");

	const stack = detectStack(cwd);
	let fixed = 0;

	// 1. Auto-fix structure issues (missing files)
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

	// 2. Run linter auto-fix
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

	// 3. AI-powered fix mode
	if (opts.ai) {
		console.log("");
		console.log("  \x1b[1mScanning for AI-fixable issues...\x1b[0m");
		const midReport = await scan(cwd, { skipTests: true });
		const aiIssues = collectFixableIssues(midReport.checks, suggestFix, opts.checkFilter);
		if (aiIssues.length === 0) {
			console.log("  \x1b[2mNo fixable issues found.\x1b[0m");
		} else {
			console.log(`  \x1b[1mAI fixing ${Math.min(aiIssues.length, 10)} issues${opts.dryRun ? " (dry run)" : ""}...\x1b[0m`);
			console.log("");
			await aiFixIssues(cwd, aiIssues, { dryRun: opts.dryRun || false });
		}
	}

	// 4. Final scan + delta report
	console.log("");
	console.log("  \x1b[1mFinal scan...\x1b[0m");
	const afterReport = await scan(cwd, { skipTests: true });
	const delta = computeDelta(beforeReport, afterReport);

	// Print delta summary
	const scoreColor = delta.scoreDelta > 0 ? "32" : delta.scoreDelta < 0 ? "31" : "2";
	const arrow = delta.scoreDelta > 0 ? "\u2191" : delta.scoreDelta < 0 ? "\u2193" : "=";
	console.log("");
	console.log(`  \x1b[1mScore:\x1b[0m \x1b[2m${beforeReport.grade} ${beforeReport.score}\x1b[0m \u2192 \x1b[${afterReport.score >= 75 ? "32" : afterReport.score >= 60 ? "33" : "31"}m${afterReport.grade} ${afterReport.score}\x1b[0m \x1b[${scoreColor}m(${arrow}${Math.abs(delta.scoreDelta)})\x1b[0m`);

	if (delta.fixed.length > 0) {
		console.log(`  \x1b[32m${delta.fixed.length} issues fixed\x1b[0m`);
		// Show top fixed by check
		const byCheck = new Map<string, number>();
		for (const f of delta.fixed) byCheck.set(f.check, (byCheck.get(f.check) || 0) + 1);
		for (const [check, count] of [...byCheck.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
			console.log(`    \x1b[32m\u2713\x1b[0m ${check}: ${count} fixed`);
		}
	}
	if (delta.introduced.length > 0) {
		console.log(`  \x1b[31m${delta.introduced.length} new issues\x1b[0m`);
	}

	// Show per-check score changes
	const changed = delta.checks.filter((c) => c.delta !== 0).sort((a, b) => b.delta - a.delta);
	if (changed.length > 0) {
		console.log("");
		for (const c of changed.slice(0, 5)) {
			const color = c.delta > 0 ? "32" : "31";
			console.log(`  \x1b[${color}m${c.delta > 0 ? "+" : ""}${c.delta}\x1b[0m ${c.name} (${c.before} \u2192 ${c.after})`);
		}
	}

	// Save delta markdown
	if (!opts.dryRun) {
		const outDir = join(cwd, ".vibe-check");
		mkdirSync(outDir, { recursive: true });
		const md = formatDeltaMarkdown(delta);
		writeFileSync(join(outDir, "delta.md"), md);
		console.log("");
		console.log(`  \x1b[2mDelta report: .vibe-check/delta.md\x1b[0m`);
	} else {
		console.log("");
		console.log("  \x1b[2mDry run — no files modified. Remove --dry-run to apply.\x1b[0m");
	}

	// Non-AI mode: show remaining fix suggestions
	if (!opts.ai) {
		const fixable: { check: string; file: string; line: number; message: string; fix: string }[] = [];
		for (const c of afterReport.checks) {
			for (const iss of c.issues) {
				if (!iss.file || typeof iss.file !== "string" || !iss.line) continue;
				const fix = suggestFix(c.name, iss.rule || "", iss.message);
				if (fix) fixable.push({ check: c.name, file: iss.file, line: iss.line, message: iss.message, fix });
			}
		}

		const top = fixable.slice(0, 5);
		if (top.length > 0) {
			console.log("");
			console.log(`  \x1b[1mRemaining fixes available:\x1b[0m \x1b[2mrun \x1b[0m\x1b[1mvcqa fix --ai\x1b[0m`);
			for (const f of top) {
				console.log(`    \x1b[2m${f.file}:${f.line}\x1b[0m ${f.fix}`);
			}
			if (fixable.length > 5) console.log(`    \x1b[2m+${fixable.length - 5} more\x1b[0m`);
		}
	}

	console.log("");
}
