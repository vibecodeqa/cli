/** Fake credentials for output-hygiene tests, built at runtime so no
 *  credential-shaped literal is ever committed. Bodies alternate an uppercase
 *  letter and a digit (no 0/1/O/I): matched by the token formats, high enough
 *  entropy for gitleaks, and a 5-character run of that shape is not something
 *  report HTML/CSS/JSON produces on its own — so a substring hit is a leak, not
 *  a coincidence. */

import { execSync } from "node:child_process";
import { randomInt } from "node:crypto";

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";

export function fakeBody(length: number): string {
	let out = "";
	for (let i = 0; i < length; i++) {
		const set = i % 2 === 0 ? LETTERS : DIGITS;
		out += set[randomInt(set.length)];
	}
	return out;
}

/** A classic GitHub PAT shape: prefix + 36 chars. Prefix joined from parts. */
export function fakeGithubPat(): { value: string; body: string } {
	const body = fakeBody(36);
	return { value: `${["gh", "p_"].join("")}${body}`, body };
}

/** Every 5-character window of `body` that occurs in `text`. Empty means clean. */
export function leakedWindows(body: string, text: string): string[] {
	const hits: string[] = [];
	for (let i = 0; i + 5 <= body.length; i++) {
		const w = body.slice(i, i + 5);
		if (text.includes(w)) hits.push(w);
	}
	return hits;
}

export function gitleaksInstalled(): boolean {
	try {
		execSync("gitleaks version", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
