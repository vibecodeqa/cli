/** SARIF 2.1.0 output for GitHub Code Scanning integration. */

import { getCheckMeta } from "../check-meta.js";
import type { VibeReport } from "../types.js";

interface SarifRule {
	id: string;
	name: string;
	shortDescription: { text: string };
	fullDescription?: { text: string };
	defaultConfiguration: { level: "error" | "warning" | "note" };
	helpUri?: string;
}

interface SarifResult {
	ruleId: string;
	level: "error" | "warning" | "note";
	message: { text: string };
	locations?: { physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } } }[];
}

export function generateSARIF(report: VibeReport): string {
	const rules: SarifRule[] = [];
	const ruleIndex = new Map<string, number>();
	const results: SarifResult[] = [];

	for (const check of report.checks) {
		const meta = getCheckMeta(check.name);

		for (const issue of check.issues) {
			const ruleId = issue.rule || check.name;

			// Register rule if not seen
			if (!ruleIndex.has(ruleId)) {
				ruleIndex.set(ruleId, rules.length);
				rules.push({
					id: ruleId,
					name: ruleId,
					shortDescription: { text: meta.label },
					fullDescription: meta.description ? { text: meta.description } : undefined,
					defaultConfiguration: { level: severityToLevel(issue.severity) },
					helpUri: "https://vibecodeqa.online",
				});
			}

			const result: SarifResult = {
				ruleId,
				level: severityToLevel(issue.severity),
				message: { text: `[${check.name}] ${issue.message}` },
			};

			if (issue.file && typeof issue.file === "string") {
				const filePath = issue.file.split(":")[0]!;
				result.locations = [
					{
						physicalLocation: {
							artifactLocation: { uri: filePath },
							...(issue.line ? { region: { startLine: issue.line } } : {}),
						},
					},
				];
			}

			results.push(result);
		}
	}

	const sarif = {
		$schema: "https://json.schemastore.org/sarif-2.1.0.json",
		version: "2.1.0" as const,
		runs: [
			{
				tool: {
					driver: {
						name: "VibeCode QA",
						version: report.version,
						informationUri: "https://vibecodeqa.online",
						rules,
					},
				},
				results,
			},
		],
	};

	return JSON.stringify(sarif, null, 2);
}

function severityToLevel(severity: "error" | "warning" | "info"): "error" | "warning" | "note" {
	if (severity === "error") return "error";
	if (severity === "warning") return "warning";
	return "note";
}
