import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan } from "./core.js";
import { detectComponents } from "./detect.js";

/** Component-detection tripwire: a real Cloudflare Worker + D1 fixture must be
 *  recognized, its components must land in report.meta.stack, and central
 *  appliesTo.component gating must work over them. Companion to the Flutter
 *  fixture e2e (issue #22 pattern: fixture first, checks second). */
const fixtureDir = fileURLToPath(new URL("../fixtures/worker-d1-app/", import.meta.url));

describe("worker+d1 fixture", () => {
	it("detects cloudflare-workers, sqlite-d1, and cloudflare-kv", () => {
		expect(detectComponents(fixtureDir)).toEqual(["cloudflare-kv", "cloudflare-workers", "sqlite-d1"]);
	});

	it("components land in report.meta.stack and no runner crashes", { timeout: 120_000 }, async () => {
		const report = await scan(fixtureDir, { skipTests: true });
		expect(report.meta.stack.components).toEqual(["cloudflare-kv", "cloudflare-workers", "sqlite-d1"]);
		const crashed = report.checks.filter(
			(c) => typeof c.details.reason === "string" && (c.details.reason as string).startsWith("runner error:"),
		);
		expect(crashed.map((c) => `${c.name}: ${c.details.reason}`)).toEqual([]);
	});

	it("does not detect components on a plain project", () => {
		const flutterFixture = fileURLToPath(new URL("../fixtures/flutter-app/", import.meta.url));
		expect(detectComponents(flutterFixture)).toEqual([]);
	});
});
