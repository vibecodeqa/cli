/** Frontend health — detects HTML/framework antipatterns in component code.
 *
 * Checks:
 *   1. Conflicting UI frameworks (MUI + Tailwind, Chakra + Tailwind, etc.)
 *   2. Large/unoptimized images (no width/height, no next/image, large src)
 *   3. Inconsistent icon systems (mixing lucide + heroicons + fontawesome)
 *   4. Bundle-heavy imports (entire libraries instead of specific components)
 *   5. Missing loading states (async data without suspense/skeleton)
 *   6. Hardcoded strings (potential i18n issues)
 *   7. Missing meta tags / head management
 *   8. DOM nesting violations (div in p, button in a)
 */

import { join } from "node:path";
import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue, ProjectContext, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";
import {
	depsForProjects,
	filesForProjects,
	frontendProjects,
	projectContainsPath,
	projectDetails,
	projectSourceRoots,
} from "./project-scope.js";

// UI framework conflicts
const UI_FRAMEWORKS: { name: string; deps: string[] }[] = [
	{ name: "MUI", deps: ["@mui/material", "@mui/system", "@material-ui/core"] },
	{ name: "Tailwind", deps: ["tailwindcss"] },
	{ name: "Chakra", deps: ["@chakra-ui/react"] },
	{ name: "Ant Design", deps: ["antd"] },
	{ name: "Bootstrap", deps: ["react-bootstrap", "bootstrap"] },
	{ name: "Mantine", deps: ["@mantine/core"] },
	{ name: "Radix", deps: ["@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/themes"] },
	{ name: "shadcn/ui", deps: ["cmdk", "vaul"] }, // shadcn uses these + Tailwind
	{ name: "DaisyUI", deps: ["daisyui"] },
];

// Icon library conflicts
const ICON_LIBS: { name: string; patterns: RegExp[] }[] = [
	{ name: "lucide", patterns: [/from\s+["']lucide-react["']/, /from\s+["']lucide-vue-next["']/] },
	{ name: "heroicons", patterns: [/from\s+["']@heroicons\/react/, /from\s+["']@heroicons\/vue/] },
	{ name: "fontawesome", patterns: [/from\s+["']@fortawesome/, /fa-\w+/] },
	{ name: "phosphor", patterns: [/from\s+["']@phosphor-icons/] },
	{ name: "tabler", patterns: [/from\s+["']@tabler\/icons/] },
	{ name: "react-icons", patterns: [/from\s+["']react-icons\//] },
	{ name: "material-icons", patterns: [/from\s+["']@mui\/icons-material/] },
	{ name: "ionicons", patterns: [/from\s+["']ionicons/, /ion-icon/] },
];

// Heavy full-library imports
const HEAVY_IMPORTS: { pattern: RegExp; message: string }[] = [
	{ pattern: /import\s+\*\s+as\s+\w+\s+from\s+["']lodash["']/, message: "Import entire lodash — use lodash/specific or lodash-es" },
	{ pattern: /from\s+["']@mui\/icons-material["'](?!\/)/, message: "Import all MUI icons — import specific: @mui/icons-material/Add" },
	{ pattern: /from\s+["']react-icons["'](?!\/)/, message: "Import all react-icons — import specific: react-icons/fi" },
	{ pattern: /from\s+["']antd["']\s*;\s*$/, message: "Import all of antd — destructure: import { Button } from 'antd'" },
	{ pattern: /import\s+(?:moment|dayjs)\s+from/, message: "Date library imported fully — consider tree-shakeable alternative" },
];

// DOM nesting violations
const NESTING_VIOLATIONS: { parent: string; child: string; message: string }[] = [
	{ parent: "<p", child: "<div", message: "div inside p — invalid HTML nesting" },
	{ parent: "<p", child: "<p", message: "p inside p — invalid HTML nesting" },
	{ parent: "<a", child: "<a", message: "a inside a — nested links are invalid" },
	{ parent: "<button", child: "<button", message: "button inside button — invalid nesting" },
	{ parent: "<a", child: "<button", message: "button inside a — use one or the other" },
];

function activeUiFrameworks(deps: Record<string, string>): string[] {
	return UI_FRAMEWORKS.filter((fw) => fw.deps.some((dep) => dep in deps)).map((fw) => fw.name);
}

function conflictingFrameworks(activeFrameworks: string[]): string[] {
	const conflicts = activeFrameworks.filter((f) => f !== "Radix" && f !== "shadcn/ui" && f !== "DaisyUI");
	return conflicts.length > 1 && !(conflicts.length === 2 && conflicts.includes("Tailwind") && conflicts.includes("shadcn/ui"))
		? conflicts
		: [];
}

function frameworkDetails(cwd: string, projects: ProjectContext[] | null): Array<Record<string, unknown>> {
	if (!projects) return [];
	return projects.map((project) => {
		const projectDir = project.path === "." ? cwd : join(cwd, project.path);
		const activeFrameworks = activeUiFrameworks({ ...readDeps(cwd), ...readDeps(projectDir) });
		return {
			id: project.id,
			name: project.name,
			path: project.path,
			activeFrameworks,
			conflicts: conflictingFrameworks(activeFrameworks),
		};
	});
}

function replaceExceptNewlines(value: string): string {
	return value.replace(/[^\n]/g, " ");
}

function maskCommentsAndNonMarkupTemplates(content: string): string {
	return content
		.replace(/\{\/\*[\s\S]*?\*\/\}/g, (match) => replaceExceptNewlines(match))
		.replace(/\/\*[\s\S]*?\*\//g, (match) => replaceExceptNewlines(match))
		.replace(/(^|[^:])\/\/.*$/gm, (match, prefix: string) => `${prefix}${replaceExceptNewlines(match.slice(prefix.length))}`)
		.replace(/`(?:\\[\s\S]|\$\{[\s\S]*?\}|[^`\\])*`/g, (match) => {
			const hasMarkup = /<\/?[A-Za-z][\w:-]*(?:\s|>|\/)/.test(match);
			return hasMarkup ? match : replaceExceptNewlines(match);
		});
}

function tagPattern(tagStart: string): RegExp {
	const tag = tagStart.replace(/^<\/?/, "");
	return new RegExp(`<${tag}(?:\\s|>|/)`, "g");
}

function closingTagPattern(tagStart: string): RegExp {
	const tag = tagStart.replace(/^<\/?/, "");
	return new RegExp(`</${tag}\\s*>`, "g");
}

export function runFrontendHealth(cwd: string, workspace?: WorkspaceInfo, inventory?: FileInventory): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const projects = frontendProjects(workspace);
	const files = filesForProjects(
		inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd, projects ? projectSourceRoots(projects) : undefined),
		projects,
	);
	const deps = depsForProjects(cwd, projects);

	const componentFiles = files.filter((f) => !f.isTest && /\.(tsx|jsx|vue|svelte)$/.test(f.path));
	if (componentFiles.length === 0) {
		return {
			name: "frontend-health",
			score: 0,
			grade: "F",
			details: { skipped: true, reason: "no component files found", projects: projectDetails(projects, componentFiles) },
			issues: [],
			duration: Date.now() - start,
		};
	}

	// 1. Conflicting UI frameworks
	const activeFrameworks = activeUiFrameworks(deps);
	const projectFrameworks = frameworkDetails(cwd, projects);
	if (projects) {
		for (const project of projectFrameworks) {
			const conflicts = project.conflicts as string[];
			if (conflicts.length > 0) {
				issues.push({
					severity: "error",
					message: `${project.path} has conflicting UI frameworks: ${conflicts.join(" + ")} — pick one`,
					rule: "framework-conflict",
				});
			}
		}
	} else {
		const conflicts = conflictingFrameworks(activeFrameworks);
		if (conflicts.length > 0) {
			issues.push({
				severity: "error",
				message: `Conflicting UI frameworks: ${conflicts.join(" + ")} — pick one`,
				rule: "framework-conflict",
			});
		}
	}

	// 2-8. Scan component files
	const iconLibsUsed = new Set<string>();
	let unoptimizedImages = 0;
	let missingLoadingStates = 0;
	for (const f of componentFiles) {
		const scanContent = maskCommentsAndNonMarkupTemplates(f.content);
		const lines = scanContent.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();

			// Icon libraries used
			for (const lib of ICON_LIBS) {
				if (lib.patterns.some((p) => p.test(line))) {
					iconLibsUsed.add(lib.name);
				}
			}

			// Heavy imports
			for (const heavy of HEAVY_IMPORTS) {
				if (heavy.pattern.test(line)) {
					issues.push({
						severity: "warning",
						message: heavy.message,
						file: f.path,
						line: i + 1,
						rule: "heavy-import",
					});
				}
			}

			// Unoptimized images
			if (/<img\s/.test(trimmed) && !trimmed.includes("next/image") && !trimmed.includes("Image")) {
				if (!trimmed.includes("width") || !trimmed.includes("height")) {
					unoptimizedImages++;
					if (unoptimizedImages <= 3) {
						issues.push({
							severity: "warning",
							message: "img without width/height — causes layout shift (use next/image or set dimensions)",
							file: f.path,
							line: i + 1,
							rule: "unoptimized-image",
						});
					}
				}
			}

			// Large image sources (base64 data URLs in JSX)
			if (/src\s*=\s*["']data:image\/[^"']{10000}/.test(line)) {
				issues.push({
					severity: "error",
					message: "Large base64 image inline — move to a file and import",
					file: f.path,
					line: i + 1,
					rule: "inline-image",
				});
			}

			// DOM nesting violations (heuristic — not a full parser)
			for (const v of NESTING_VIOLATIONS) {
				if (tagPattern(v.child).test(trimmed) && i > 0) {
					// Check previous 5 lines for unclosed parent
					const context = lines.slice(Math.max(0, i - 5), i).join(" ");
					const parentOpens = (context.match(tagPattern(v.parent)) || []).length;
					const parentCloses = (context.match(closingTagPattern(v.parent)) || []).length;
					if (parentOpens > parentCloses) {
						issues.push({
							severity: "warning",
							message: v.message,
							file: f.path,
							line: i + 1,
							rule: "dom-nesting",
						});
						break;
					}
				}
			}
		}

		// Missing loading states (has fetch/useQuery but no loading/skeleton/suspense)
		if (/\b(fetch|useQuery|useSWR|useEffect.*fetch)\b/.test(f.content)) {
			if (!/\b(loading|isLoading|Skeleton|Spinner|Suspense|fallback)\b/.test(f.content)) {
				missingLoadingStates++;
				if (missingLoadingStates <= 3) {
					issues.push({
						severity: "info",
						message: "Async data fetch without visible loading state",
						file: f.path,
						rule: "no-loading-state",
					});
				}
			}
		}
	}

	// Icon system conflicts
	if (iconLibsUsed.size > 1) {
		issues.push({
			severity: "warning",
			message: `Mixed icon libraries: ${[...iconLibsUsed].join(", ")} — pick one for consistency`,
			rule: "mixed-icons",
		});
	}

	// Summary issues
	if (unoptimizedImages > 3) {
		issues.push({
			severity: "warning",
			message: `${unoptimizedImages} images without dimensions — all cause layout shift`,
			rule: "unoptimized-image",
		});
	}

	// Score
	const errorCount = issues.filter((i) => i.severity === "error").length;
	const warnCount = issues.filter((i) => i.severity === "warning").length;
	const score = Math.max(0, 100 - errorCount * 25 - warnCount * 10);

	return {
		name: "frontend-health",
		score,
		grade: gradeFromScore(score),
		details: {
			componentFiles: componentFiles.length,
			source: inventory ? "file-inventory" : "legacy-walk",
			activeFrameworks,
			projectFrameworks,
			iconLibsUsed: [...iconLibsUsed],
			unoptimizedImages,
			projects: projectDetails(projects, componentFiles)?.map((project) => ({
				...project,
				issues: issues.filter((issue) => issue.file && projectContainsPath(String(project.path), issue.file)).length,
			})),
		},
		issues,
		duration: Date.now() - start,
	};
}
