import path from 'node:path';

/**
 * Path constants shared by the LangGraph compile target
 * (targets/langgraph.js) and doctor.js's freshness check
 * (checkLangGraphCompileTarget). Deliberately kept in lib/ rather than
 * targets/langgraph.js itself: pipelines/deploy/targets/ is source-repo-only
 * generator internals, explicitly denied from every packaged archive
 * (package-dev-graph.js / package-dev-sub.js / package-ops.js DENY_LIST,
 * "generator internals: deploy targets (not copied by deployExtras)") — a
 * doctor.js importing from targets/ directly would ERR_MODULE_NOT_FOUND in
 * every deployed hub. lib/ files are allowlisted per-tier instead (see
 * lib-import-allowlist-coverage.test.js), so this file is added to each
 * packaging profile's LIB_ALLOWLIST/LIB_ALWAYS alongside profiles.js,
 * validate-utils.js, and compose-portable-prompt.js.
 */

/**
 * Relative path (from outputRoot/hubRoot) of the directory generated prompt
 * artifacts are written to.
 */
export const LANGGRAPH_GENERATED_DIR = path.join('runtime', 'langgraph', 'generated');

/**
 * Relative path (from outputRoot/hubRoot) of the runtime source directory
 * migrated from the standalone ops-langgraph POC.
 */
export const LANGGRAPH_RUNTIME_DIR = path.join('runtime', 'langgraph');

/**
 * Derive the generated-artifact filename for a given profile id.
 * e.g. 'cao' -> 'cao_system_prompt.txt'
 */
export function langGraphArtifactFileName(agentId) {
	return `${agentId}_system_prompt.txt`;
}
