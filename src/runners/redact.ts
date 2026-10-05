/** Credential patterns, and the redactors that apply them to anything we persist.
 *
 *  `SECRET_PATTERNS` is what the `secrets` check reports on. `redactSecrets()`
 *  applies those same patterns, ports of the secretlint recommended preset's
 *  token formats, and label-based rules (KEY=value, URL userinfo, auth headers)
 *  to text: tool logs (`redactToolOutput`) and every string of a check result
 *  (`redactDeep`). It is synchronous so the recorder can redact before it
 *  truncates — a value cut in half no longer matches any pattern.
 *
 *  Every pattern is bounded or anchored to a token start: this runs over tool
 *  output an attacker can shape (a file in a PR lands in eslint/test output),
 *  so a super-linear pattern would hang the scan. */

const REDACTED = "[REDACTED]";

/** Patterns the built-in secrets scan reports on. One finding per pattern per line. */
export const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
	{
		name: "Credential Placeholder",
		pattern:
			/(?:Authorization:\s*Bearer\s+(?:YOUR_TOKEN|EXAMPLE_TOKEN|DUMMY_TOKEN|FAKE_TOKEN|TEST_TOKEN)\b|\btoken=(?:abc|abcdef)[a-z0-9]{8,28}\b|\bsk-(?:round-trip|owner-only|test|fixture|dummy|fake|sample|x\d)[a-z0-9_-]{3,32}\b)/i,
	},
	{ name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/ },
	{
		name: "AWS Secret Key",
		pattern: /(?:aws_secret|AWS_SECRET)[^=\n]{0,64}=\s*['"][A-Za-z0-9/+=]{40}['"]/,
	},
	{ name: "GitHub Token (classic)", pattern: /ghp_[A-Za-z0-9]{36}/ },
	{
		name: "GitHub Token (fine-grained)",
		pattern: /github_pat_[A-Za-z0-9_]{22,}/,
	},
	{ name: "GitHub OAuth", pattern: /gho_[A-Za-z0-9]{36}/ },
	{ name: "Slack Token", pattern: /xox[bpors]-[0-9a-zA-Z-]{10,}/ },
	{ name: "Stripe Secret Key", pattern: /sk_live_[0-9a-zA-Z]{24,}/ },
	{ name: "Stripe Publishable Key", pattern: /pk_live_[0-9a-zA-Z]{24,}/ },
	{
		name: "OpenAI API Key",
		pattern: /sk-(?:proj-|svc-|[A-Za-z0-9]{2})[A-Za-z0-9_-]{20,}/,
	},
	{ name: "Anthropic API Key", pattern: /sk-ant-api\d{2}-[A-Za-z0-9-]{80,}/ },
	{ name: "Google API Key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
	{
		name: "Private Key",
		pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
	},
	{
		name: "Generic Secret Assignment",
		pattern: /(?:password|secret|api_key|apikey|token|auth)\s*[:=]\s*['"][A-Za-z0-9+/=]{20,}['"]/,
	},
];

/** Characters a bare token is made of; the lookbehind anchors patterns to a token start. */
const NOT_AFTER_TOKEN = "(?<![A-Za-z0-9_-])";

/** Patterns whose first capture group is a label to keep (a key name, a URL's
 *  scheme and user) and whose remainder is the value to drop. */
const LABELLED_VALUE_PATTERNS: RegExp[] = [
	// scheme://user:password@host — the password runs to the LAST @ before the host,
	// so a password containing @ is dropped whole (basicauth, mongodb, mysql, postgres).
	/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{1,20}:\/\/[^:/\s@"'`]{1,256}:)([^/\s"'`]{1,256})(?=@[^@/\s"'`]{0,256}(?:[/\s"'`?#]|$))/gi,
	// https://TOKEN:x-oauth-basic@github.com
	/(https?:\/\/)([^:/\s@"'`]{1,256})(?=:x-oauth-basic@)/gi,
	// scheme://TOKEN@host — a token as the whole userinfo (git remotes, Sentry DSNs)
	/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{1,20}:\/\/)([^:/\s@"'`]{16,256})(?=@)/gi,
	// .npmrc
	/(_authToken[ \t]*=[ \t]*)([^\s"'`]{1,512})/g,
	// AWS secret access key assignments
	/((?:aws)?_?secret_?(?:access)?_?key["']?[ \t]*[:=][ \t]*["']?)([A-Za-z0-9/+=]{40})/gi,
	// Generic quoted assignment (mirrors SECRET_PATTERNS' "Generic Secret Assignment")
	/((?:password|secret|api_key|apikey|token|auth)[ \t]*[:=][ \t]*['"])([A-Za-z0-9+/=]{20,})/gi,
];

/** Authorization header values. */
const AUTH_HEADER = /\b((?:Bearer|Basic|Token)[ \t]+)([A-Za-z0-9._~+/=-]{16,4096})/gi;

/** A name that is a credential whatever its value looks like. */
const STRONG_NAME = /(?:secret|token|passw(?:or)?d|passphrase|pwd|credential|(?:^|[_.-])(?:sk|pat|pw)$|^(?:sk|pat|pw)[_.-])/i;
/** A name that is a credential only when the value looks like one. */
const WEAK_NAME = /(?:key|auth(?!or)|dsn|private|session|cookie)/i;

/** NAME=value, NAME: value, "name": "value", NAME="value with spaces". The name
 *  is one token, matched only at a token start, so this stays linear. */
const ASSIGNMENT =
	/(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_.-]{0,127})(["']?[ \t]*[:=][ \t]*)(?:(["'])([^"'\n]{1,512})\3|([^\s"'`,;]{1,512}))/g;

function isCredentialValue(name: string, value: string, quoted: boolean): boolean {
	if (value.startsWith("[REDACTED") || value === "REDACTED") return false;
	// References, code and literals, not values: $VAR, {expr}, [list], true, 1234.
	if (/^[[{(<$%]|^process\.env|^(?:true|false|null|undefined|none|nil)$/i.test(value)) return false;
	if (/^[\d.]+$/.test(value)) return false;
	// Code, not a value: `token = getToken()`, `password: req.body.password`.
	if (!quoted && (/[()]/.test(value) || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value))) return false;
	if (STRONG_NAME.test(name)) return value.length >= 6;
	if (!WEAK_NAME.test(name)) return false;
	if (quoted && value.length >= 8 && /\s/.test(value)) return true;
	return value.length >= 20 || (value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value));
}

/** Token formats with a recognisable prefix — the secretlint recommended preset's
 *  rules plus the formats SECRET_PATTERNS knows. The whole match is the secret. */
const TOKEN_PATTERNS: RegExp[] = [
	new RegExp(`${NOT_AFTER_TOKEN}eyJ[A-Za-z0-9_-]{5,8192}\\.[A-Za-z0-9_-]{5,8192}\\.[A-Za-z0-9_-]{5,8192}`, "g"), // JWT
	/\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g,
	/ghs_[0-9]{1,20}_[A-Za-z0-9_-]{1,1000}\.[A-Za-z0-9_-]{1,10000}\.[A-Za-z0-9_-]{1,1000}/g,
	/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}/g,
	/github_pat_[A-Za-z0-9_]{22,}/g,
	/(?:xoxb|xoxp|xapp|xoxa|xoxo|xoxr|xoxs)-[A-Za-z0-9-]{10,}/g,
	/https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]{1,40}\/B[A-Za-z0-9]{1,40}\/[A-Za-z0-9]{1,40}/gi,
	/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,99}/g,
	/\bsk-[A-Za-z0-9_-]{20,}/g,
	/\bAIza[0-9A-Za-z_-]{35}/g,
	/npm_[A-Za-z0-9_]{36}/g,
	/\bgsk_[A-Za-z0-9]{52}/g,
	/\bhf_[A-Za-z]{34}/g,
	/\blin_api_[A-Za-z0-9_]{32,128}/g,
	/\bntn_[0-9]{11}[A-Za-z0-9]{35}/g,
	/\bSG\.[\w-]{16,128}\.[\w-]{16,128}/g,
	/\bshp(?:pa|ca|at|ss)_[A-Za-z0-9]{32,64}/g,
	/glpat-[A-Za-z0-9_-]{20,128}/g,
	/\bglc_[A-Za-z0-9+/]{32,400}={0,2}/g,
	/\bglsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}/g,
	/\bops_ey[A-Za-z0-9+/=]{100,1280}/g,
	/\bhv[sbr]\.[A-Za-z0-9_-]{90,300}/g,
	/\b(?:vcp|vci|vca|vcr|vck)_[A-Za-z0-9]{20,60}/g,
	/\bdapi[A-Fa-f0-9]{32}(?:-[0-9])?/g,
	/dckr_pat_[A-Za-z0-9_-]{27}/g,
	/figd_[A-Za-z0-9_-]{40,200}/g,
	/(?:cfk|cfut|cfat)_[A-Za-z0-9]{40}[0-9a-f]{8}/g,
	/\btskey-[a-z]{2,20}-[0-9A-Za-z_]{8,40}-[0-9A-Za-z_]{16,60}/g,
];

const BUILT_IN_GLOBAL = SECRET_PATTERNS.map(
	({ pattern }) => new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`),
);

const PEM_BEGIN = /-----BEGIN[ A-Z]{0,20}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END[ A-Z]{0,20}PRIVATE KEY(?: BLOCK)?-----/;
const PEM_MAX_BODY = 16 * 1024;

/** PEM private keys, body included. A forward scan with a bounded body instead
 *  of a lazy regex: an unterminated BEGIN must not make this quadratic. */
function redactPem(text: string): string {
	if (!text.includes("PRIVATE KEY")) return text;
	let out = "";
	let last = 0;
	PEM_BEGIN.lastIndex = 0;
	for (let m = PEM_BEGIN.exec(text); m; m = PEM_BEGIN.exec(text)) {
		if (m.index < last) continue;
		const bodyStart = m.index + m[0].length;
		const window = text.slice(bodyStart, bodyStart + PEM_MAX_BODY);
		const end = PEM_END.exec(window);
		// No END in range (truncated output): drop the base64-ish run that follows.
		const bodyLen = end ? end.index + end[0].length : (/^[A-Za-z0-9+/=\s\\]*/.exec(window)?.[0].length ?? 0);
		out += text.slice(last, m.index) + REDACTED;
		last = bodyStart + bodyLen;
		PEM_BEGIN.lastIndex = Math.max(last, PEM_BEGIN.lastIndex);
	}
	return out + text.slice(last);
}

/** Replace every credential-shaped value in `text` with `[REDACTED]`. */
export function redactSecrets(text: string): string {
	if (!text || text.length < 6) return text;
	let out = redactPem(text);
	for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
	const hasUrl = out.includes("://");
	for (const re of LABELLED_VALUE_PATTERNS) {
		if (!hasUrl && re.source.includes(":\\/\\/")) continue; // URL patterns need a URL
		out = out.replace(re, (_m, label: string) => `${label}${REDACTED}`);
	}
	out = out.replace(AUTH_HEADER, (m, label: string, value: string) => (/\d/.test(value) || value.length >= 24 ? `${label}${REDACTED}` : m));
	out = out.replace(
		ASSIGNMENT,
		(m, name: string, sep: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
			const value = quoted ?? bare ?? "";
			if (!isCredentialValue(name, value, quote !== undefined)) return m;
			return quote ? `${name}${sep}${quote}${REDACTED}${quote}` : `${name}${sep}${REDACTED}`;
		},
	);
	for (const re of BUILT_IN_GLOBAL) out = out.replace(re, REDACTED);
	return out;
}

/** How far past the cap we redact. Redaction only ever looks at a bounded
 *  prefix (so a 64 MB log costs what a 72 KB one does), and what is kept is
 *  always well inside the redacted region. */
const REDACT_LOOKAHEAD = 64 * 1024;
/** Dropped from the end of a redacted prefix: a value cut by the prefix boundary
 *  may not match any pattern, so the text near that boundary is never kept. */
const BOUNDARY_MARGIN = 4096;

/** Tool output as it may be persisted: redacted, then capped at `cap` chars. */
export function redactToolOutput(text: string, cap: number): string {
	const trimmed = text.trim();
	const prefixed = trimmed.length > cap + REDACT_LOOKAHEAD;
	let out = redactSecrets(prefixed ? trimmed.slice(0, cap + REDACT_LOOKAHEAD) : trimmed);
	if (prefixed) out = out.slice(0, Math.max(0, out.length - BOUNDARY_MARGIN));
	return out.slice(0, cap);
}

/** `value` with every string inside it (objects and arrays, recursively) redacted. */
export function redactDeep<T>(value: T, seen: WeakMap<object, unknown> = new WeakMap()): T {
	if (typeof value === "string") return redactSecrets(value) as T;
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return seen.get(value) as T;
	if (Array.isArray(value)) {
		const arr: unknown[] = [];
		seen.set(value, arr);
		for (const item of value) arr.push(redactDeep(item, seen));
		return arr as T;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return value; // Dates, Maps, class instances
	const obj: Record<string, unknown> = {};
	seen.set(value, obj);
	for (const [k, v] of Object.entries(value)) obj[k] = redactDeep(v, seen);
	return obj as T;
}
