import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContainerHealth } from "./container-health.js";
import { runEnvValidation } from "./env-validation.js";
import { runMemorySafety } from "./memory-safety.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vcqa-new-"));
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("env-validation", () => {
	it("passes when no .env files exist", () => {
		const result = runEnvValidation(dir);
		expect(result.score).toBeGreaterThanOrEqual(80);
	});

	it("flags .env not in .gitignore", () => {
		writeFileSync(join(dir, ".env"), "DB_URL=postgres://localhost");
		writeFileSync(join(dir, ".gitignore"), "node_modules\n");
		const result = runEnvValidation(dir);
		expect(result.issues.some((i) => i.rule === "env-not-ignored")).toBe(true);
	});

	it("flags missing .env.example", () => {
		writeFileSync(join(dir, ".env"), "SECRET=abc");
		writeFileSync(join(dir, ".gitignore"), ".env\n");
		const result = runEnvValidation(dir);
		expect(result.issues.some((i) => i.rule === "no-env-example")).toBe(true);
	});

	it("detects .env.example drift", () => {
		writeFileSync(join(dir, ".env"), "A=1\nB=2\n");
		writeFileSync(join(dir, ".env.example"), "A=\nC=\n");
		writeFileSync(join(dir, ".gitignore"), ".env\n");
		const result = runEnvValidation(dir);
		const drift = result.issues.filter((i) => i.rule === "env-example-drift");
		expect(drift.length).toBeGreaterThanOrEqual(2); // B missing from example, C missing from .env
	});

	it("passes clean setup", () => {
		writeFileSync(join(dir, ".env"), "API_KEY=xxx\n");
		writeFileSync(join(dir, ".env.example"), "API_KEY=\n");
		writeFileSync(join(dir, ".gitignore"), ".env\nnode_modules\n");
		const result = runEnvValidation(dir);
		expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
	});
});

describe("memory-safety", () => {
	it("passes clean code", () => {
		writeFileSync(join(dir, "src", "app.ts"), "export function hello() { return 'hi'; }\n");
		const result = runMemorySafety(dir);
		expect(result.score).toBe(100);
		expect(result.issues).toHaveLength(0);
	});

	it("flags setInterval without clearInterval", () => {
		writeFileSync(join(dir, "src", "timer.ts"), "setInterval(() => { console.log('tick'); }, 1000);\n");
		const result = runMemorySafety(dir);
		expect(result.issues.some((i) => i.rule === "interval-leak")).toBe(true);
	});

	it("passes setInterval with clearInterval", () => {
		writeFileSync(join(dir, "src", "timer.ts"), "const id = setInterval(() => {}, 1000);\nclearInterval(id);\n");
		const result = runMemorySafety(dir);
		expect(result.issues.some((i) => i.rule === "interval-leak")).toBe(false);
	});

	it("flags addEventListener without remove", () => {
		writeFileSync(join(dir, "src", "ui.ts"), 'window.addEventListener("click", handler);\n');
		const result = runMemorySafety(dir);
		expect(result.issues.some((i) => i.rule === "listener-leak")).toBe(true);
	});

	it("passes addEventListener with removeEventListener", () => {
		writeFileSync(join(dir, "src", "ui.ts"), 'window.addEventListener("click", handler);\nwindow.removeEventListener("click", handler);\n');
		const result = runMemorySafety(dir);
		expect(result.issues.some((i) => i.rule === "listener-leak")).toBe(false);
	});

	it("flags global variable assignment", () => {
		writeFileSync(join(dir, "src", "globals.ts"), "window.myApp = {};\n");
		const result = runMemorySafety(dir);
		expect(result.issues.some((i) => i.rule === "global-pollution")).toBe(true);
	});
});

describe("container-health", () => {
	it("skips when no Dockerfile", () => {
		const result = runContainerHealth(dir);
		expect((result.details as Record<string, unknown>).skipped).toBe(true);
	});

	it("flags unpinned base image", () => {
		writeFileSync(join(dir, "Dockerfile"), "FROM node\nRUN npm install\n");
		const result = runContainerHealth(dir);
		expect(result.issues.some((i) => i.rule === "unpinned-base")).toBe(true);
	});

	it("flags :latest tag", () => {
		writeFileSync(join(dir, "Dockerfile"), "FROM node:latest\nRUN npm install\n");
		const result = runContainerHealth(dir);
		expect(result.issues.some((i) => i.rule === "latest-tag")).toBe(true);
	});

	it("flags missing .dockerignore", () => {
		writeFileSync(join(dir, "Dockerfile"), "FROM node:22-slim\nRUN npm install\n");
		const result = runContainerHealth(dir);
		expect(result.issues.some((i) => i.rule === "no-dockerignore")).toBe(true);
	});

	it("flags running as root", () => {
		writeFileSync(join(dir, "Dockerfile"), "FROM node:22-slim\nRUN npm install\n");
		const result = runContainerHealth(dir);
		expect(result.issues.some((i) => i.rule === "runs-as-root")).toBe(true);
	});

	it("passes well-configured Dockerfile", () => {
		writeFileSync(join(dir, "Dockerfile"), "FROM node:22-slim AS build\nRUN npm install\nFROM node:22-slim\nUSER node\nEXPOSE 3000\n");
		writeFileSync(join(dir, ".dockerignore"), "node_modules\n.git\n.env\n");
		const result = runContainerHealth(dir);
		expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
		expect(result.issues.filter((i) => i.rule === "runs-as-root")).toHaveLength(0);
	});

	it("flags COPY . before npm install", () => {
		writeFileSync(join(dir, "Dockerfile"), "FROM node:22\nCOPY . /app\nRUN npm install\nUSER node\n");
		writeFileSync(join(dir, ".dockerignore"), "node_modules\n.git\n.env\n");
		const result = runContainerHealth(dir);
		expect(result.issues.some((i) => i.rule === "cache-bust")).toBe(true);
	});
});
