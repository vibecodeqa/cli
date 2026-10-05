import { describe, expect, it } from "vitest";
import { resolveFailUnder } from "./fail-under.js";

describe("resolveFailUnder (#108)", () => {
	it("honours config failUnder under --ci instead of the CI default", () => {
		expect(resolveFailUnder(null, 80, true)).toEqual({ threshold: 80, source: "config" });
		expect(resolveFailUnder(null, 40, true)).toEqual({ threshold: 40, source: "config" });
	});

	it("lets --fail-under override both config and the CI default", () => {
		expect(resolveFailUnder(90, 40, true)).toEqual({ threshold: 90, source: "flag" });
		expect(resolveFailUnder(30, 80, false)).toEqual({ threshold: 30, source: "flag" });
		expect(resolveFailUnder(0, 80, true)).toEqual({ threshold: 0, source: "flag" });
	});

	it("falls back to 60 under --ci only when config sets nothing", () => {
		expect(resolveFailUnder(null, undefined, true)).toEqual({ threshold: 60, source: "ci default" });
	});

	it("does not gate outside CI with no flag and no config", () => {
		expect(resolveFailUnder(null, undefined, false)).toEqual({ threshold: 0, source: "none" });
	});

	it("treats a config failUnder of 0 as an explicit choice", () => {
		expect(resolveFailUnder(null, 0, true)).toEqual({ threshold: 0, source: "config" });
	});
});
