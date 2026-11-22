/**
 * The result a "*.setup-plugin.js" run() returns, and the helpers that read it.
 *
 * A plugin used to report a failed step only by printing an ERROR or WARNING
 * line, so setup could not tell a clean run from one that failed. Now run()
 * returns a result:
 *
 *   { ok: true,  step }                               every step finished
 *   { ok: false, step, message }                      one step failed
 *   { ok: false, step, message, failures: [{step, message}] }
 *                                                      several steps failed
 *
 *   { ok: true, step, warnings: [{step, message, summary}] }
 *                                                      the step did not finish, but
 *                                                      setup still counts as complete
 *
 * A warning is for a step that is advisory: setup completes and stamps, and
 * lists the warning in its closing summary. `summary` is the plugin's own
 * one-line text for that list.
 *
 * Plugins may add their own fields beside these (for example `ran`, `status`).
 * What a plugin prints is not changed by returning a result.
 *
 * setup.js never names a plugin or a step. It collects the failures from every
 * plugin with failuresOf() and decides from the list alone.
 */

/** A step that finished (or had nothing to do). */
export function stepOk(step, extra = {}) {
	return { ...extra, ok: true, step };
}

/** A step that did not finish. `message` says why, in one line. */
export function stepFailed(step, message, extra = {}) {
	return { ...extra, ok: false, step, message };
}

/**
 * An advisory step that did not finish. The result is ok, so setup still
 * completes and stamps; the warning is listed in the closing summary.
 *
 * @param {string} step
 * @param {string} message  Why, in one line.
 * @param {string} summary  The line shown in the closing summary.
 */
export function stepWarning(step, message, summary, extra = {}) {
	return { ...extra, ok: true, step, warnings: [{ step, message, summary }] };
}

/**
 * Fold a plugin's failed sub-steps into one result.
 *
 * @param {string} step  Plugin-level step name, used when nothing failed.
 * @param {Array<{step: string, message: string}>} failures
 * @param {object} [extra]  Plugin-specific fields kept on the result.
 */
export function resultFromFailures(step, failures, extra = {}) {
	if (failures.length === 0) return stepOk(step, extra);
	if (failures.length === 1) {
		return stepFailed(failures[0].step, failures[0].message, extra);
	}
	return {
		...extra,
		ok: false,
		step,
		message: `${failures.length} steps failed: ${failures.map((f) => f.step).join(', ')}`,
		failures,
	};
}

/**
 * The failed steps in one plugin result, as a flat list.
 *
 * Anything that is not a result object counts as no failure: a plugin that
 * returns nothing predates this contract and is trusted as before. Only an
 * explicit `ok: false` is a failure.
 *
 * @param {unknown} result
 * @returns {Array<{step: string, message: string}>}
 */
export function failuresOf(result) {
	if (!result || typeof result !== 'object' || result.ok !== false) return [];
	if (Array.isArray(result.failures) && result.failures.length > 0) {
		return result.failures.map((f) => ({
			step: String(f.step ?? result.step ?? 'unknown'),
			message: String(f.message ?? ''),
		}));
	}
	return [
		{
			step: String(result.step ?? 'unknown'),
			message: String(result.message ?? ''),
		},
	];
}

/**
 * The warnings in one plugin result, as a flat list.
 *
 * @param {unknown} result
 * @returns {Array<{step: string, message: string, summary: string}>}
 */
export function warningsOf(result) {
	if (!result || typeof result !== 'object') return [];
	if (!Array.isArray(result.warnings)) return [];
	return result.warnings.map((w) => ({
		step: String(w.step ?? result.step ?? 'unknown'),
		message: String(w.message ?? ''),
		summary: String(w.summary ?? w.message ?? ''),
	}));
}
