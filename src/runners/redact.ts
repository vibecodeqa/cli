/** Credential patterns, and the redactor that applies them to recorded tool output.
 *
 *  `SECRET_PATTERNS` is what the `secrets` check reports on. `redactSecrets()`
 *  applies those same patterns — plus ports of the secretlint recommended
 *  preset's token formats — to any text we are about to persist (tool logs in
 *  `details.toolRuns`). It is synchronous on purpose: `run()` must redact the
 *  full output before it truncates it, and a value cut in half by truncation
 *  no longer matches any pattern. */

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
		pattern: /(?:aws_secret|AWS_SECRET)[^=]*=\s*['"][A-Za-z0-9/+=]{40}['"]/,
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
		pattern: /sk-(?:proj-|svc-|[A-Za-z0-9]{2,})[A-Za-z0-9_-]{20,}/,
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

/** Patterns whose first capture group is a label to keep (a key name, a URL's
 *  scheme and user) and whose remainder is the value to drop. */
const LABELLED_VALUE_PATTERNS: RegExp[] = [
	// user:password@host in any URL / connection string (basicauth, mongodb, mysql, postgres)
	/([a-z][a-z0-9+.-]{1,20}:\/\/[^:/\s@"'`]{1,256}:)([^@/\s"'`]{1,256})(?=@)/gi,
	// https://TOKEN:x-oauth-basic@github.com
	/(https?:\/\/)([^:/\s@"'`]{1,256})(?=:x-oauth-basic@)/gi,
	// .npmrc
	/(_authToken\s*=\s*)([^\s"'`]+)/g,
	// AWS secret access key assignments
	/((?:aws)?_?secret_?(?:access)?_?key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})/gi,
	// Generic quoted assignment (mirrors SECRET_PATTERNS' "Generic Secret Assignment")
	/((?:password|secret|api_key|apikey|token|auth)\s*[:=]\s*['"])([A-Za-z0-9+/=]{20,})/gi,
];

/** KEY=value / "key": "value" where the name says it is a credential. The value
 *  must look like one (letters and digits, or long) so prose and counters survive. */
const SENSITIVE_ASSIGNMENT =
	/([A-Za-z0-9_.-]{0,64}(?:key|secret|token|passw(?:or)?d|pwd|credential|auth)[A-Za-z0-9_.-]{0,64}["']?\s*[:=]\s*["']?)([^\s"'`,;]{12,})/gi;

/** Token formats with a recognisable prefix — the secretlint recommended preset's
 *  rules plus the formats SECRET_PATTERNS knows. The whole match is the secret. */
const TOKEN_PATTERNS: RegExp[] = [
	// PEM private keys: the body, not just the header. A truncated block has no END.
	/-----BEGIN[ A-Z]{0,20}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[ A-Z]{0,20}PRIVATE KEY(?: BLOCK)?-----/g,
	/-----BEGIN[ A-Z]{0,20}PRIVATE KEY(?: BLOCK)?-----[A-Za-z0-9+/=\s\\]*/g,
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

function looksLikeCredential(value: string): boolean {
	if (value === REDACTED || value.startsWith("[REDACTED")) return false;
	return value.length >= 20 || (/[A-Za-z]/.test(value) && /\d/.test(value));
}

/** Replace every credential-shaped value in `text` with `[REDACTED]`. */
export function redactSecrets(text: string): string {
	if (!text) return text;
	let out = text;
	for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
	for (const re of LABELLED_VALUE_PATTERNS) out = out.replace(re, (_m, label: string) => `${label}${REDACTED}`);
	out = out.replace(SENSITIVE_ASSIGNMENT, (m, label: string, value: string) => (looksLikeCredential(value) ? `${label}${REDACTED}` : m));
	for (const re of BUILT_IN_GLOBAL) out = out.replace(re, REDACTED);
	return out;
}
