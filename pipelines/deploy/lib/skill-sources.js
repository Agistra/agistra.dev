import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Load the skill catalog from disk. The catalog is shipped as part of this
 * CLI's own code (a pointer registry of name/repo/path/ref) — it is never
 * vendored third-party content itself.
 *
 * @param {string} configPath absolute path to skill-catalog.json
 * @returns {{ name: string, repo: string, path: string, ref: string }[]}
 */
export function loadSkillCatalog(configPath) {
	if (!fs.existsSync(configPath)) return [];
	const raw = fs.readFileSync(configPath, 'utf-8');
	const parsed = JSON.parse(raw);
	return Array.isArray(parsed.skills) ? parsed.skills : [];
}

/**
 * Look up a single named entry in the catalog.
 *
 * @param {string} configPath absolute path to skill-catalog.json
 * @param {string} name catalog entry name
 * @returns {{ name: string, repo: string, path: string, ref: string } | undefined}
 */
export function findSkillCatalogEntry(configPath, name) {
	return loadSkillCatalog(configPath).find((entry) => entry.name === name);
}

function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Recursively list every file under a path in a GitHub repo via the contents API.
 *
 * @param {object} options
 * @param {string} options.repo "owner/name"
 * @param {string} options.subPath path within the repo
 * @param {string} options.ref branch or tag
 * @param {typeof fetch} options.fetchFn
 * @returns {Promise<{ path: string, download_url: string }[]>} flat list of file entries (paths relative to repo root)
 */
async function listFilesRecursive({ repo, subPath, ref, fetchFn }) {
	const url = `https://api.github.com/repos/${repo}/contents/${subPath}?ref=${encodeURIComponent(ref)}`;
	const headers = {
		'User-Agent': 'setchin-agent-profiles-install-skill',
		Accept: 'application/vnd.github+json',
	};
	if (process.env.GITHUB_TOKEN)
		headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

	const res = await fetchFn(url, { headers });
	if (!res.ok) {
		throw new Error(`GitHub API ${res.status} for ${url}`);
	}
	const body = await res.json();
	const entries = Array.isArray(body) ? body : [body];

	const files = [];
	for (const entry of entries) {
		if (entry.type === 'file') {
			files.push({ path: entry.path, download_url: entry.download_url });
		} else if (entry.type === 'dir') {
			const nested = await listFilesRecursive({
				repo,
				subPath: entry.path,
				ref,
				fetchFn,
			});
			files.push(...nested);
		}
	}
	return files;
}

/**
 * Fetch one catalog entry's declared source directly into destRoot/<name>/,
 * comparing content hashes to determine whether the result is added/updated/unchanged.
 *
 * Caller controls destRoot entirely — this function never assumes or defaults
 * to setchin-agent-profiles' own skills/ directory.
 *
 * @param {object} options
 * @param {{ name: string, repo: string, path: string, ref: string }} options.entry
 * @param {string} options.destRoot absolute path to the invoking hub's own skills/ root
 * @param {typeof fetch} [options.fetchFn]
 * @param {(filename: string, content: string) => string} [options.fileTransform]
 *   Optional per-file transform applied to each fetched file's text content before
 *   writing to disk. Receives the filename (basename only, e.g. "SKILL.md") and the
 *   UTF-8 string content; returns the modified string. Callers use this to apply
 *   skill-specific modifications at fetch time without keeping a local modified copy
 *   in the source repo. When omitted, content is written as-is.
 * @returns {Promise<{ name: string, status: 'added'|'updated'|'unchanged'|'error', filesWritten: string[], error?: string }>}
 */
export async function installSkillFromCatalog({
	entry,
	destRoot,
	fetchFn = fetch,
	fileTransform,
}) {
	const { name, repo, path: subPath, ref = 'main' } = entry;
	const destSkillDir = path.join(destRoot, name);

	try {
		const files = await listFilesRecursive({ repo, subPath, ref, fetchFn });
		if (files.length === 0) {
			return {
				name,
				status: 'error',
				filesWritten: [],
				error: `no files found at ${repo}:${subPath}@${ref}`,
			};
		}

		const existedBefore = fs.existsSync(destSkillDir);
		let anyChanged = false;
		const filesWritten = [];

		for (const file of files) {
			const relPath = path
				.relative(subPath, file.path)
				.split('/')
				.join(path.sep);
			const destPath = path.join(destSkillDir, relPath);

			const fileRes = await fetchFn(file.download_url, {
				headers: { 'User-Agent': 'setchin-agent-profiles-install-skill' },
			});
			if (!fileRes.ok) {
				throw new Error(
					`failed to download ${file.path}: HTTP ${fileRes.status}`,
				);
			}
			let newContent = Buffer.from(await fileRes.arrayBuffer());

			// Apply the caller's per-file transform when one is provided. The transform
			// receives the filename (e.g. "SKILL.md") and UTF-8 string content, and
			// returns modified content. Used by the marketing-skills installer to strip
			// prospecting's dangling "Tool Integrations" section at fetch time,
			// without keeping a local modified copy in the source repo.
			if (fileTransform) {
				const filename = path.basename(file.path);
				newContent = Buffer.from(
					fileTransform(filename, newContent.toString('utf-8')),
					'utf-8',
				);
			}

			const existed = fs.existsSync(destPath);
			const changed =
				!existed || sha256(fs.readFileSync(destPath)) !== sha256(newContent);

			if (changed) {
				fs.mkdirSync(path.dirname(destPath), { recursive: true });
				fs.writeFileSync(destPath, newContent);
				anyChanged = true;
			}
			filesWritten.push(relPath);
		}

		const status = !existedBefore
			? 'added'
			: anyChanged
				? 'updated'
				: 'unchanged';
		return { name, status, filesWritten };
	} catch (err) {
		return { name, status: 'error', filesWritten: [], error: err.message };
	}
}
