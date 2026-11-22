/**
 * Lexical containment checks, shared by every "is this path inside that
 * folder" site. `path.relative(...).startsWith('..')` is wrong for a child
 * folder whose name merely begins with ".." (e.g. "..cache"); only a leading
 * ".." path segment, or a different drive (absolute result), means outside.
 *
 * These helpers are purely lexical: they never touch the disk. Callers that
 * must see through links, junctions or 8.3 names resolve both paths to real
 * paths first (work-cli.js's normalisePath) and then call these.
 */
import path from 'node:path';

/**
 * The path of `child` relative to `parent`, or null when `child` lies outside
 * `parent` (or on another drive). '' means `child` is `parent` itself.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {string|null}
 */
export function relativeInside(parent, child) {
	const rel = path.relative(parent, child);
	if (rel === '') return '';
	if (path.isAbsolute(rel)) return null;
	if (rel === '..' || rel.startsWith(`..${path.sep}`)) return null;
	return rel;
}

/**
 * True when `child` is `parent` or sits somewhere below it.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isSameOrInside(parent, child) {
	return relativeInside(parent, child) !== null;
}
