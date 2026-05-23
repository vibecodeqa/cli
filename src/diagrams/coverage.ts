/** Coverage map — modules as boxes, colored by test coverage status. */

import { basename, extname } from "node:path";

interface CoverageMapInput {
	/** All production source files */
	sourceFiles: string[];
	/** Test files matched to source files (from testing runner pairing) */
	testedFiles: Set<string>;
	/** Files grouped by directory */
	dirs: Map<string, string[]>;
}

export function buildCoverageMapInput(
	archGraph: Record<string, { imports: string[]; importedBy: string[]; dir: string }> | undefined,
	testingDetails: Record<string, unknown> | undefined,
): CoverageMapInput | null {
	if (!archGraph || Object.keys(archGraph).length === 0) return null;

	const sourceFiles = Object.keys(archGraph);
	const dirs = new Map<string, string[]>();
	for (const [path, info] of Object.entries(archGraph)) {
		const dir = info.dir || ".";
		const arr = dirs.get(dir) || [];
		arr.push(path);
		dirs.set(dir, arr);
	}

	// Build set of tested files from testing runner's pairing data
	const testedFiles = new Set<string>();
	if (testingDetails) {
		// The testing runner reports untested files — invert to get tested
		const allIssues = (testingDetails as { issues?: { rule?: string; file?: string }[] }).issues || [];
		const untestedSet = new Set(allIssues.filter((i) => i.rule === "untested-file" && i.file).map((i) => i.file!));
		for (const f of sourceFiles) {
			if (!untestedSet.has(f)) testedFiles.add(f);
		}
	}

	return { sourceFiles, testedFiles, dirs };
}

export function generateCoverageMap(input: CoverageMapInput): string {
	const { sourceFiles, testedFiles, dirs } = input;
	if (sourceFiles.length === 0) return "";
	if (sourceFiles.length > 120) {
		return `<div style="color:#6b7280;font-size:0.75rem">${sourceFiles.length} modules — too many to render coverage map.</div>`;
	}

	const boxW = 120;
	const boxH = 24;
	const gapX = 8;
	const gapY = 6;
	const padding = 40;
	const headerH = 20;

	const dirEntries = [...dirs.entries()];
	const maxPerDir = Math.max(...dirEntries.map(([, files]) => files.length));

	// Layout: directories as columns, files as rows within each column
	const colWidth = boxW + gapX;
	const W = Math.max(400, padding * 2 + dirEntries.length * colWidth);
	const H = padding + headerH + maxPerDir * (boxH + gapY) + 60;

	const testedCount = testedFiles.size;
	const coveragePct = Math.round((testedCount / sourceFiles.length) * 100);

	let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,monospace" style="width:100%;max-width:${W}px">`;

	// Summary bar at top
	const barW = W - padding * 2;
	const greenW = Math.round((coveragePct / 100) * barW);
	svg += `<rect x="${padding}" y="8" width="${barW}" height="12" rx="3" fill="#ef444430"/>`;
	svg += `<rect x="${padding}" y="8" width="${greenW}" height="12" rx="3" fill="#22c55e60"/>`;
	svg += `<text x="${padding + barW / 2}" y="17" text-anchor="middle" fill="#9ca3af" font-size="8" font-weight="700">${coveragePct}% covered (${testedCount}/${sourceFiles.length})</text>`;

	// Directory columns with file boxes
	let colIdx = 0;
	for (const [dirName, files] of dirEntries) {
		const x = padding + colIdx * colWidth;
		const label = dirName === "." ? "root" : dirName.split("/").pop() || dirName;

		// Directory header
		svg += `<text x="${x + boxW / 2}" y="${padding + headerH}" text-anchor="middle" fill="#6b7280" font-size="9" font-weight="700">${label}</text>`;

		// File boxes
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			const name = basename(file, extname(file));
			const y = padding + headerH + 8 + i * (boxH + gapY);
			const tested = testedFiles.has(file);
			const fill = tested ? "#22c55e18" : "#ef444418";
			const stroke = tested ? "#22c55e40" : "#ef444440";
			const icon = tested ? "✓" : "✗";
			const iconColor = tested ? "#22c55e" : "#ef4444";

			svg += `<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
			svg += `<text x="${x + 14}" y="${y + 16}" fill="#d1d5db" font-size="9">${name}</text>`;
			svg += `<text x="${x + 4}" y="${y + 16}" fill="${iconColor}" font-size="10" font-weight="700">${icon}</text>`;
		}
		colIdx++;
	}

	// Legend
	const ly = H - 20;
	svg += `<rect x="${padding}" y="${ly}" width="10" height="10" rx="2" fill="#22c55e18" stroke="#22c55e40"/>`;
	svg += `<text x="${padding + 14}" y="${ly + 9}" fill="#6b7280" font-size="8">has test file</text>`;
	svg += `<rect x="${padding + 90}" y="${ly}" width="10" height="10" rx="2" fill="#ef444418" stroke="#ef444440"/>`;
	svg += `<text x="${padding + 104}" y="${ly + 9}" fill="#6b7280" font-size="8">no test file</text>`;

	svg += `</svg>`;
	return svg;
}
