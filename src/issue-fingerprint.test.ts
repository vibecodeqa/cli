import { describe, expect, it } from "vitest";
import { fingerprintIssue, withIssueFingerprints } from "./issue-fingerprint.js";

describe("issue fingerprints", () => {
	it("are stable across line movement", () => {
		const a = fingerprintIssue("security", {
			severity: "error",
			rule: "xss",
			file: "src/app.ts",
			line: 10,
			message: "Dangerous HTML sink",
		});
		const b = fingerprintIssue("security", {
			severity: "error",
			rule: "xss",
			file: "src/app.ts",
			line: 42,
			message: "Dangerous   HTML sink",
		});
		expect(a).toBe(b);
	});

	it("are stable across severity reclassification", () => {
		const a = fingerprintIssue("sqlite-d1", {
			severity: "error",
			rule: "sql-dynamic-identifier",
			file: "src/db.ts",
			message: "Table name interpolated into SQL",
		});
		const b = fingerprintIssue("sqlite-d1", {
			severity: "warning",
			rule: "sql-dynamic-identifier",
			file: "src/db.ts",
			message: "Table name interpolated into SQL",
		});
		expect(a).toBe(b);
	});

	it("adds fingerprints to issues without changing issue fields", () => {
		const issues = withIssueFingerprints("lint", [{ severity: "warning", rule: "demo", message: "Use const", file: "src/a.ts" }]);
		expect(issues[0]).toMatchObject({ severity: "warning", rule: "demo", message: "Use const", file: "src/a.ts" });
		expect(issues[0].fingerprint).toMatch(/^[a-f0-9]{16}$/);
	});
});
