/**
 * Version parsing and comparison utilities.
 */

/**
 * Parse a semver string from a VERSION file line.
 * Accepts "1.2.3" or "1.2.3 # comment".
 * Returns the version string or null if not parseable.
 * @param {string} raw
 * @returns {string|null}
 */
export function parseVersion(raw) {
	if (typeof raw !== 'string') return null;
	const match = raw.trim().match(/^(\d+\.\d+\.\d+)/);
	return match ? match[1] : null;
}

/**
 * Compare two semver strings.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Returns null if either is not valid semver.
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1|null}
 */
export function compareVersions(a, b) {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) return null;
	const [aMaj, aMin, aPat] = pa.split('.').map(Number);
	const [bMaj, bMin, bPat] = pb.split('.').map(Number);
	if (aMaj !== bMaj) return aMaj > bMaj ? 1 : -1;
	if (aMin !== bMin) return aMin > bMin ? 1 : -1;
	if (aPat !== bPat) return aPat > bPat ? 1 : -1;
	return 0;
}

/**
 * True when the string is a bare, well-formed semver ("1.2.3") with no
 * marker comment, leading `v`, or surrounding whitespace. Used to validate
 * an explicit version-override input before it's written to VERSION.
 * @param {string} str
 * @returns {boolean}
 */
export function isValidSemver(str) {
	return typeof str === 'string' && /^\d+\.\d+\.\d+$/.test(str);
}

/**
 * Compute the next semver version for a given bump type.
 * @param {string} current Current semver string (marker comments are fine — parsed first).
 * @param {'patch'|'minor'|'major'} bumpType
 * @returns {string|null} New semver string, or null if `current` isn't parseable or
 *   `bumpType` isn't one of the three recognised values.
 */
export function bumpVersion(current, bumpType) {
	const parsed = parseVersion(current);
	if (!parsed) return null;
	const [major, minor, patch] = parsed.split('.').map(Number);
	switch (bumpType) {
		case 'major':
			return `${major + 1}.0.0`;
		case 'minor':
			return `${major}.${minor + 1}.0`;
		case 'patch':
			return `${major}.${minor}.${patch + 1}`;
		default:
			return null;
	}
}

/**
 * Rewrite a VERSION file's raw content with a new version, preserving
 * whatever trailing comment (e.g. `# x-release-please-version`) the original
 * line carried, and preserving both whether the file ended with a trailing
 * newline and whether that newline was LF or CRLF (the repo's own checkout
 * is CRLF on Windows via `core.autocrlf=true`, even though the blob stored in
 * git is LF-only — this function is defensive to whichever line ending the
 * caller's working-tree copy actually has). If the original had no comment,
 * none is added.
 * @param {string} originalContent Raw content of the VERSION file.
 * @param {string} newVersion New semver string to write.
 * @returns {string} New file content.
 */
export function rewriteVersionFile(originalContent, newVersion) {
	const usesCRLF = originalContent.includes('\r\n');
	const trailingNewline = originalContent.endsWith('\n')
		? usesCRLF
			? '\r\n'
			: '\n'
		: '';
	const firstLine = originalContent.split(/\r?\n/)[0];
	const commentMatch = firstLine.match(/\s*(#.*)$/);
	const comment = commentMatch ? ` ${commentMatch[1]}` : '';
	return `${newVersion}${comment}${trailingNewline}`;
}

/**
 * Rewrite a package.json file's top-level `"version"` field via targeted
 * string replacement — never JSON.parse/stringify — so every other byte
 * (indentation style, line endings, key order) is preserved exactly. Returns
 * the original content unchanged if no `"version"` field is present, so
 * callers can safely no-op on a package.json that doesn't carry one.
 * @param {string} originalContent Raw content of package.json.
 * @param {string} newVersion New semver string to write.
 * @returns {string} New file content.
 */
export function rewritePackageJsonVersion(originalContent, newVersion) {
	const versionFieldRegex = /("version"\s*:\s*")[^"]*(")/;
	if (!versionFieldRegex.test(originalContent)) return originalContent;
	return originalContent.replace(versionFieldRegex, `$1${newVersion}$2`);
}
