import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSourceFiles, setGlobalSrcRoots } from "../fs-utils.js";
import { runAccessibility } from "./accessibility.js";
import { runSecurity } from "./security.js";

const TMP = join(import.meta.dirname!, "__test_vue_svelte__");

beforeEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(join(TMP, "src"), { recursive: true });
	writeFileSync(join(TMP, "package.json"), JSON.stringify({ dependencies: { vue: "^3" } }));
	setGlobalSrcRoots(undefined);
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	setGlobalSrcRoots(undefined);
});

describe("Vue SFC support", () => {
	it("extracts script from .vue files", () => {
		writeFileSync(
			join(TMP, "src", "App.vue"),
			`<template><div>{{ msg }}</div></template>
<script setup lang="ts">
import { ref } from 'vue'
const msg = ref('hello')
</script>`,
		);
		const files = collectSourceFiles(TMP);
		expect(files).toHaveLength(1);
		expect(files[0].ext).toBe(".vue");
		expect(files[0].content).toContain("import { ref }");
		expect(files[0].content).not.toContain("<template>");
	});

	it("preserves rawContent for template checks", () => {
		writeFileSync(join(TMP, "src", "App.vue"), `<template><img src="x"></template>\n<script setup>\nconst x = 1\n</script>`);
		const files = collectSourceFiles(TMP);
		expect(files[0].rawContent).toContain("<template>");
		expect(files[0].rawContent).toContain("<img");
	});

	it("detects v-html as XSS in security runner", () => {
		writeFileSync(
			join(TMP, "src", "Danger.vue"),
			`<template><div v-html="userInput"></div></template>\n<script setup>\nconst userInput = ''\n</script>`,
		);
		const result = runSecurity(TMP);
		const vhtmlIssues = result.issues.filter((i) => i.message.includes("v-html"));
		expect(vhtmlIssues.length).toBeGreaterThan(0);
		expect(vhtmlIssues[0].severity).toBe("warning");
	});

	it("detects missing img alt in Vue template", () => {
		writeFileSync(join(TMP, "src", "Bad.vue"), `<template><img src="photo.jpg"></template>\n<script setup>\n</script>`);
		const result = runAccessibility(TMP);
		expect(result.issues.some((i) => i.rule === "img-alt")).toBe(true);
	});

	it("detects @click without keyboard handler", () => {
		writeFileSync(
			join(TMP, "src", "Click.vue"),
			`<template><div @click="go">Click me</div></template>\n<script setup>\nfunction go() {}\n</script>`,
		);
		const result = runAccessibility(TMP);
		expect(result.issues.some((i) => i.rule === "click-events")).toBe(true);
	});
});

describe("Svelte support", () => {
	it("extracts script from .svelte files", () => {
		writeFileSync(
			join(TMP, "src", "App.svelte"),
			`<script>\nlet count = 0\nfunction inc() { count++ }\n</script>\n<button on:click={inc}>{count}</button>`,
		);
		const files = collectSourceFiles(TMP);
		expect(files).toHaveLength(1);
		expect(files[0].ext).toBe(".svelte");
		expect(files[0].content).toContain("let count");
		expect(files[0].content).not.toContain("<button");
	});

	it("detects {@html} as XSS in security runner", () => {
		writeFileSync(join(TMP, "src", "Raw.svelte"), `<script>\nlet html = '<b>danger</b>'\n</script>\n{@html html}`);
		const result = runSecurity(TMP);
		const htmlIssues = result.issues.filter((i) => i.message.includes("{@html}"));
		expect(htmlIssues.length).toBeGreaterThan(0);
	});
});
