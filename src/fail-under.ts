/** Resolve the exit threshold for a scan and say where it came from.
 *
 *  Precedence: `--fail-under` flag → config `failUnder` (.vcqa.json /
 *  package.json#vcqa) → `--ci` default of 60 → 0 (no gate). A config value
 *  is honoured under `--ci`: the CI default only applies when the project has
 *  not chosen its own threshold (#108). */

export type FailUnderSource = "flag" | "config" | "ci default" | "none";

export interface FailUnder {
	threshold: number;
	source: FailUnderSource;
}

export const CI_DEFAULT_FAIL_UNDER = 60;

export function resolveFailUnder(flag: number | null | undefined, configValue: number | undefined, ciMode: boolean): FailUnder {
	if (flag != null) return { threshold: flag, source: "flag" };
	if (configValue != null) return { threshold: configValue, source: "config" };
	if (ciMode) return { threshold: CI_DEFAULT_FAIL_UNDER, source: "ci default" };
	return { threshold: 0, source: "none" };
}
