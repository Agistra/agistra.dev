/**
 * Scheduled Task run-state classification.
 *
 * `schtasks /query /v` reports a task's `Last Run Time` and `Last Result`. Windows
 * uses informational result codes that are not failures: 0x41303 means the task has
 * not yet run, 0x41301 means it is running now. A never-run task also reports a
 * placeholder run time of 30 November 1999, formatted per locale. This module turns
 * the raw pair into one state so doctor checks do not each re-derive it.
 */

/** SCHED_S_TASK_HAS_NOT_RUN */
export const TASK_RESULT_NOT_RUN = 0x41303;
/** SCHED_S_TASK_RUNNING */
export const TASK_RESULT_RUNNING = 0x41301;

const NEVER_RUN_TIME = /^(N\/A|Never)$/i;
// Day-first (30/11/1999), month-first (11/30/1999), dotted and dashed variants.
const PLACEHOLDER_DMY = /^\s*30[/.-]0?11[/.-]1999(?!\d)/;
const PLACEHOLDER_MDY = /^\s*0?11[/.-]30[/.-]1999(?!\d)/;
const PLACEHOLDER_ISO = /^\s*1999-0?11-0?30(?!\d)/;

/**
 * True when a `Last Run Time` value means "never ran" in any locale format.
 *
 * @param {string|null|undefined} lastRunTime
 * @returns {boolean}
 */
export function isNeverRunTime(lastRunTime) {
	if (lastRunTime == null) return false;
	const value = String(lastRunTime).trim();
	return (
		NEVER_RUN_TIME.test(value) ||
		PLACEHOLDER_DMY.test(value) ||
		PLACEHOLDER_MDY.test(value) ||
		PLACEHOLDER_ISO.test(value)
	);
}

/**
 * Formats a result code as "<decimal> (0x<hex>)".
 *
 * @param {number} code
 * @returns {string}
 */
export function formatTaskResultCode(code) {
	return `${code} (0x${(code >>> 0).toString(16).toUpperCase()})`;
}

/**
 * Classifies a task's run state.
 *
 * - `not-run`: result 0x41303, or the run time is N/A / Never / the 1999 placeholder
 * - `running`: result 0x41301
 * - `ok`: result 0
 * - `failed`: any other numeric result
 * - `unknown`: no numeric result and no never-run signal (task absent or query failed)
 *
 * @param {object} info
 * @param {string|null} [info.lastRunTime]
 * @param {number|null} [info.lastResult]
 * @returns {{ state: 'not-run'|'running'|'ok'|'failed'|'unknown', code: number|null, codeText: string|null }}
 */
export function classifyTaskRunState({ lastRunTime, lastResult } = {}) {
	const code = typeof lastResult === 'number' ? lastResult : null;
	const codeText = code == null ? null : formatTaskResultCode(code);
	if (code === TASK_RESULT_NOT_RUN || isNeverRunTime(lastRunTime)) {
		return { state: 'not-run', code, codeText };
	}
	if (code === TASK_RESULT_RUNNING) return { state: 'running', code, codeText };
	if (code === 0) return { state: 'ok', code, codeText };
	if (code == null) return { state: 'unknown', code, codeText };
	return { state: 'failed', code, codeText };
}
