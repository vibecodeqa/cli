import type { AnalyzerMetric, AnalyzerSnapshot, CheckResult, Issue } from "./types.js";

const DETAIL_DENYLIST = new Set(["assessment", "containerSvg", "graph", "reason", "skipped", "status", "toolRuns"]);

export function buildAnalyzerSnapshots(checks: CheckResult[]): AnalyzerSnapshot[] {
	return checks.map((check) => ({
		analyzerId: check.name,
		status: checkStatus(check),
		score: Number.isFinite(Number(check.score)) ? Number(check.score) : undefined,
		findingCount: check.issues.length,
		severityCounts: severityCounts(check.issues),
		metrics: normalizedMetrics(check),
		durationMs: check.duration,
	}));
}

function checkStatus(check: CheckResult): AnalyzerSnapshot["status"] {
	const details = check.details as Record<string, unknown>;
	const status = details.status;
	if (typeof status === "string" && status) return status;
	if (details.comingSoon) return "unavailable";
	if (details.skipped) return "skipped";
	if (details.scoreImpact === false || details.scoreMode === "available-unscored") return "passed";
	if (check.issues.some((issue) => issue.severity === "error") || Number(check.score) < 60) return "failed";
	return "passed";
}

function severityCounts(issues: Issue[]): Record<string, number> {
	const counts = { error: 0, warning: 0, info: 0 };
	for (const issue of issues) {
		counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
	}
	return counts;
}

function normalizedMetrics(check: CheckResult): AnalyzerMetric[] {
	const explicit = explicitMetrics(check.details);
	if (explicit.length > 0) return explicit;
	return detailMetrics(check.details);
}

function explicitMetrics(details: Record<string, unknown>): AnalyzerMetric[] {
	const raw = details.metrics;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const metric = item as Record<string, unknown>;
		if (typeof metric.id !== "string" || typeof metric.label !== "string") return [];
		if (!isMetricValue(metric.value)) return [];
		return [
			{
				id: metric.id,
				label: metric.label,
				value: metric.value,
				...(isMetricUnit(metric.unit) ? { unit: metric.unit } : {}),
				...(isMetricTrend(metric.trend) ? { trend: metric.trend } : {}),
			},
		];
	});
}

function detailMetrics(details: Record<string, unknown>): AnalyzerMetric[] {
	const metrics: AnalyzerMetric[] = [];
	for (const [key, value] of Object.entries(details)) {
		if (metrics.length >= 12) break;
		if (DETAIL_DENYLIST.has(key) || !isMetricValue(value)) continue;
		metrics.push({
			id: key,
			label: humanizeMetricId(key),
			value,
			...(typeof value === "number" ? { unit: metricUnitForId(key) } : {}),
			trend: metricTrendForId(key),
		});
	}
	return metrics;
}

function humanizeMetricId(id: string): string {
	return id
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function metricUnitForId(id: string): AnalyzerMetric["unit"] {
	const lower = id.toLowerCase();
	if (lower.includes("score")) return "score";
	if (lower.includes("duration") || lower.endsWith("ms")) return "ms";
	if (lower.includes("percent") || lower.endsWith("pct") || lower.includes("ratio")) return "percent";
	if (lower.includes("bytes") || lower.includes("size")) return "bytes";
	return "count";
}

function metricTrendForId(id: string): AnalyzerMetric["trend"] {
	const lower = id.toLowerCase();
	if (lower.includes("score") || lower.includes("coverage") || lower.includes("passed")) return "higher-is-better";
	if (lower.includes("error") || lower.includes("warning") || lower.includes("issue") || lower.includes("failed")) return "lower-is-better";
	return "neutral";
}

function isMetricValue(value: unknown): value is AnalyzerMetric["value"] {
	return typeof value === "number" || typeof value === "string" || typeof value === "boolean";
}

function isMetricUnit(value: unknown): value is NonNullable<AnalyzerMetric["unit"]> {
	return value === "count" || value === "percent" || value === "ms" || value === "bytes" || value === "score";
}

function isMetricTrend(value: unknown): value is NonNullable<AnalyzerMetric["trend"]> {
	return value === "higher-is-better" || value === "lower-is-better" || value === "neutral";
}
