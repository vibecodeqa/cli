/** vcqa init — set up CI workflow + recommended configs. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectStack } from "../detect.js";
import { validateCwd } from "./shared.js";

export async function runInit(cwd: string): Promise<void> {
	console.log("");
	console.log(`  \x1b[1m\x1b[38;5;141mvcqa init\x1b[0m`);
	console.log(`  \x1b[2m${cwd}\x1b[0m`);
	console.log("");

	validateCwd(cwd);

	const stack = detectStack(cwd);
	let created = 0;

	// 1. GitHub Actions workflow
	const workflowDir = join(cwd, ".github", "workflows");
	const workflowPath = join(workflowDir, "vibecodeqa.yml");
	if (!existsSync(workflowPath)) {
		try {
			mkdirSync(workflowDir, { recursive: true });
			writeFileSync(
				workflowPath,
				`name: VibeCode QA
on: [pull_request]
permissions: { contents: read }
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx @vibecodeqa/cli --ci --fail-under 70 --sarif --badge
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: .vibe-check/report.sarif
`,
			);
			console.log(`  \x1b[32m+\x1b[0m .github/workflows/vibecodeqa.yml`);
			created++;
		} catch {
			console.log(`  \x1b[31m!\x1b[0m .github/workflows/vibecodeqa.yml (write failed — check permissions)`);
		}
	} else {
		console.log(`  \x1b[2m=\x1b[0m .github/workflows/vibecodeqa.yml (exists)`);
	}

	// 2. Biome config (if biome is a dep but no config exists)
	if (
		(stack.linter === "biome" || existsSync(join(cwd, "node_modules", "@biomejs", "biome"))) &&
		!existsSync(join(cwd, "biome.json")) &&
		!existsSync(join(cwd, "biome.jsonc"))
	) {
		writeFileSync(
			join(cwd, "biome.json"),
			JSON.stringify(
				{
					$schema: "https://biomejs.dev/schemas/2.0.0/schema.json",
					formatter: { indentStyle: "tab", lineWidth: 120 },
					linter: { enabled: true, rules: { recommended: true } },
					organizeImports: { enabled: true },
				},
				null,
				"\t",
			) + "\n",
		);
		console.log(`  \x1b[32m+\x1b[0m biome.json`);
		created++;
	}

	// 3. Create .vcqa.json if not present
	const vcqaConfigPath = join(cwd, ".vcqa.json");
	if (!existsSync(vcqaConfigPath)) {
		const { CHECK_META } = await import("../check-meta.js");
		const checksConfig: Record<string, Record<string, unknown>> = {};
		for (const name of Object.keys(CHECK_META)) {
			checksConfig[name] = {};
		}
		const config = {
			_comment: "vcqa config — docs: https://vibecodeqa.online/skills",
			checks: checksConfig,
			_checks_help: "Set { \"enabled\": false } to disable. Add \"ignore\": [\"generated/**\"] to skip files per-check.",
			ignore: [],
			_ignore_help: "Global file patterns to skip: [\"vendor/**\", \"*.generated.ts\", \"proto/**\"]",
			failUnder: 60,
			_failUnder_help: "Exit with code 1 if score below this. Overridden by --fail-under flag.",
		};
		writeFileSync(vcqaConfigPath, JSON.stringify(config, null, 2) + "\n");
		console.log(`  \x1b[32m+\x1b[0m .vcqa.json`);
		created++;
	}

	// 4. Add .vibe-check to .gitignore
	const gitignorePath = join(cwd, ".gitignore");
	if (existsSync(gitignorePath)) {
		const content = readFileSync(gitignorePath, "utf-8");
		if (!content.includes(".vibe-check")) {
			writeFileSync(gitignorePath, content.trimEnd() + "\n.vibe-check/\n");
			console.log(`  \x1b[32m+\x1b[0m .gitignore (added .vibe-check/)`);
			created++;
		}
	}

	console.log("");
	if (created > 0) {
		console.log(`  \x1b[32mCreated ${created} file(s).\x1b[0m Run \x1b[1mnpx @vibecodeqa/cli\x1b[0m to scan.`);
	} else {
		console.log(`  \x1b[2mAlready set up. Run npx @vibecodeqa/cli to scan.\x1b[0m`);
	}
	console.log("");
}
