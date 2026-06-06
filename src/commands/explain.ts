/** vcqa explain — deep-dive explanation of a check. */

import { getCheckMeta } from "../check-meta.js";

export async function runExplain(checkName?: string): Promise<void> {
	if (!checkName) {
		console.log("\n  \x1b[1mUsage:\x1b[0m vcqa explain <check>\n");
		console.log("  Available checks:");
		const { CHECK_META } = await import("../check-meta.js");
		for (const [name, meta] of Object.entries(CHECK_META)) {
			console.log(`    \x1b[1m${name.padEnd(16)}\x1b[0m ${meta.label} (${meta.category}, ${meta.weight}%)`);
		}
		console.log("");
		return;
	}
	const meta = getCheckMeta(checkName);
	if (!meta.description || meta.description.length < 20) {
		console.log(`\n  \x1b[31mUnknown check: ${checkName}\x1b[0m`);
		console.log("  Run \x1b[1mvcqa explain\x1b[0m to see available checks.\n");
		return;
	}
	console.log("");
	console.log(
		`  \x1b[1m\x1b[38;5;141m${meta.label}\x1b[0m  \x1b[2m${meta.category} · ${meta.priority} priority · ${meta.weight}% weight\x1b[0m`,
	);
	console.log("");
	console.log(`  \x1b[1mWhat:\x1b[0m ${meta.description}`);
	console.log("");
	console.log(`  \x1b[1mRisk:\x1b[0m ${meta.risk}`);
	console.log("");
	console.log(`  \x1b[1mFix:\x1b[0m ${meta.recommendation}`);
	if (meta.deeperTools?.length) {
		console.log("");
		console.log(`  \x1b[1mGo deeper:\x1b[0m ${meta.deeperTools.join(", ")}`);
	}
	console.log("");
}
