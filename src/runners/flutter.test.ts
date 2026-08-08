import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectStack, detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { runFlutter } from "./flutter.js";

const TMP = join(import.meta.dirname!, "__test_flutter__");

beforeEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

function write(path: string, content: string): void {
	const full = join(TMP, path);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
}

const flutterPubspec = `name: sample_app
environment:
  sdk: ">=3.0.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter
dev_dependencies:
  flutter_test:
    sdk: flutter
  integration_test:
    sdk: flutter
  flutter_lints: ^4.0.0
flutter:
  uses-material-design: true
`;

describe("flutter runner", () => {
	it("detects convention-only Flutter package roots", () => {
		write("app/pubspec.yaml", flutterPubspec);
		write("app/analysis_options.yaml", "include: package:flutter_lints/flutter.yaml\n");
		write("app/lib/main.dart", "void main() {}\n");
		write("admin/pubspec.yaml", flutterPubspec.replace("sample_app", "admin_app"));
		write("admin/lib/main.dart", "void main() {}\n");
		write("shared/pubspec.yaml", flutterPubspec.replace("sample_app", "shared_pkg"));
		write("shared/lib/shared.dart", "class Shared {}\n");

		const workspace = detectWorkspace(TMP);
		const stack = detectStack(TMP, workspace);

		expect(workspace.isMonorepo).toBe(true);
		expect(workspace.packages.map((p) => p.path).sort()).toEqual(["admin", "app", "shared"]);
		expect(stack.language).toBe("dart");
		expect(stack.framework).toBe("flutter");
		expect(stack.linter).toBe("dart_analyze");
	});

	it("summarizes Flutter app/package health", () => {
		write("app/pubspec.yaml", flutterPubspec);
		write("app/analysis_options.yaml", "include: package:flutter_lints/flutter.yaml\n");
		write("app/lib/main.dart", "void main() {}\n");
		write("app/test/widget_test.dart", "void main() { testWidgets('home', (WidgetTester tester) async {}); }\n");
		write("app/integration_test/app_test.dart", "void main() {}\n");
		write("shared/pubspec.yaml", flutterPubspec.replace("sample_app", "shared_pkg"));
		write("shared/lib/model.freezed.dart", "// generated\n");
		write("shared/lib/model.dart", "class Model {}\n");

		const workspace = detectWorkspace(TMP);
		const result = runFlutter(TMP, workspace);

		expect(result.name).toBe("flutter");
		expect(result.details.packages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "app", kind: "app", widgetTests: 1, integrationTests: 1 }),
				expect.objectContaining({ path: "shared", kind: "package", generatedFiles: 1 }),
			]),
		);
		expect(result.details.metrics).toEqual(expect.arrayContaining([expect.objectContaining({ id: "widgetTests", value: 1 })]));
		expect(result.issues.some((issue) => issue.rule === "generated-files-neutral")).toBe(true);
	});

	it("reads Dart files from the shared FileInventory, generated ones included", () => {
		write("app/pubspec.yaml", flutterPubspec);
		write("app/analysis_options.yaml", "include: package:flutter_lints/flutter.yaml\n");
		write("app/lib/main.dart", "void main() {}\n");
		write("app/test/widget_test.dart", "void main() { testWidgets('home', (WidgetTester tester) async {}); }\n");
		write("app/integration_test/app_test.dart", "void main() {}\n");
		write("shared/pubspec.yaml", flutterPubspec.replace("sample_app", "shared_pkg"));
		write("shared/lib/model.dart", "class Model {}\n");
		write("shared/lib/model.freezed.dart", "// generated\n");
		// Excluded by the shared policy — but this check *measures* generated Dart,
		// so it must still reach it, via the inventory's rejected-file list.
		write("shared/lib/model.g.dart", "// generated\n");
		// Genuinely out of scope: a pruned build directory stays pruned.
		write("shared/build/stale.dart", "class Stale {}\n");

		const workspace = detectWorkspace(TMP);
		const policy = buildEffectiveScanPolicy(TMP, {});
		const inventory = buildFileInventory(TMP, workspace, policy);
		const legacy = runFlutter(TMP, workspace);
		const result = runFlutter(TMP, workspace, inventory);

		const shared = result.details.packages.find((pkg: any) => pkg.path === "shared");
		expect(inventory.files.some((file) => file.path === "shared/lib/model.g.dart")).toBe(false);
		expect(inventory.ignoredFiles.map((file) => file.path)).toContain("shared/lib/model.g.dart");
		expect(shared).toMatchObject({ generatedFiles: 2, sourceFiles: 1 });
		expect(result.details.packages).toEqual(legacy.details.packages);
		expect(result.issues.some((issue) => issue.rule === "generated-files-neutral")).toBe(true);
	});

	it("prefers ProjectContext Flutter projects in mixed workspaces", () => {
		write("package.json", JSON.stringify({ workspaces: ["apps/*"] }));
		write("apps/mobile/pubspec.yaml", flutterPubspec);
		write("apps/mobile/lib/main.dart", "void main() {}\n");
		write("apps/web/package.json", JSON.stringify({ dependencies: { react: "^19.0.0" } }));
		write("apps/web/src/App.tsx", "export function App() { return <div />; }\n");

		const workspace = detectWorkspace(TMP);
		const result = runFlutter(TMP, workspace);

		expect(result.details.packages).toEqual([expect.objectContaining({ path: "apps/mobile", kind: "app" })]);
		expect(result.details.packages.some((pkg: any) => pkg.path === "apps/web")).toBe(false);
	});
});
