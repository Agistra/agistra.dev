import fs from 'node:fs';
import path from 'node:path';

function normalizeAuthoredLines(authoredLines) {
	if (!Array.isArray(authoredLines)) return null;
	const uniqueLines = [...new Set(authoredLines.filter(line => typeof line === 'string' && line.length > 0))];
	return uniqueLines;
}

export function deriveAuthoredLines(previousContent, nextContent) {
	if (typeof previousContent !== 'string' || typeof nextContent !== 'string') {
		return [];
	}
	const previousLines = new Set(previousContent.split('\n'));
	return [...new Set(nextContent
		.split('\n')
		.filter(line => line.length > 0 && !previousLines.has(line)))];
}

function normalizeBaselineContent(baselineContent) {
	return typeof baselineContent === 'string' ? baselineContent : null;
}

function normalizeWrittenFileEntry(filePath, options = {}) {
	if (!filePath) return null;
	if (typeof filePath === 'string') {
		const authoredLines = normalizeAuthoredLines(options.authoredLines);
		return {
			path: path.resolve(filePath),
			authoredLines,
			baselineContent: normalizeBaselineContent(options.baselineContent),
		};
	}
	if (typeof filePath === 'object' && typeof filePath.path === 'string') {
		return {
			path: path.resolve(filePath.path),
			authoredLines: normalizeAuthoredLines(filePath.authoredLines),
			baselineContent: normalizeBaselineContent(filePath.baselineContent),
		};
	}
	return null;
}

export function addWrittenFile(writtenFiles, filePath, options = {}) {
	const entry = normalizeWrittenFileEntry(filePath, options);
	if (!entry) return writtenFiles;
	writtenFiles.push(Array.isArray(entry.authoredLines) || entry.baselineContent !== null ? entry : entry.path);
	return writtenFiles;
}

export function addWrittenFiles(writtenFiles, filePaths = []) {
	for (const filePath of filePaths) {
		addWrittenFile(writtenFiles, filePath);
	}
	return writtenFiles;
}

export function uniqueWrittenFiles(filePaths = []) {
	const mergedByPath = new Map();
	for (const filePath of filePaths) {
		const entry = normalizeWrittenFileEntry(filePath);
		if (!entry) continue;
		const existing = mergedByPath.get(entry.path);
		if (!existing) {
			mergedByPath.set(entry.path, {
				path: entry.path,
				authoredLines: Array.isArray(entry.authoredLines) ? new Set(entry.authoredLines) : null,
				baselineContent: entry.baselineContent,
			});
			continue;
		}
		if (existing.authoredLines === null || entry.authoredLines === null) {
			existing.authoredLines = null;
			existing.baselineContent = null;
			continue;
		}
		for (const line of entry.authoredLines) {
			existing.authoredLines.add(line);
		}
		if (existing.baselineContent === null && entry.baselineContent !== null) {
			existing.baselineContent = entry.baselineContent;
		}
	}
	return [...mergedByPath.values()].map(entry => (
		entry.authoredLines === null && entry.baselineContent === null
			? entry.path
			: {
				path: entry.path,
				authoredLines: entry.authoredLines === null ? null : [...entry.authoredLines],
				baselineContent: entry.baselineContent,
			}
	));
}

export function copyDirTracked(src, dest, { fsMod = fs, exclude = [] } = {}) {
	const writtenFiles = [];
	fsMod.mkdirSync(dest, { recursive: true });
	for (const entry of fsMod.readdirSync(src, { withFileTypes: true })) {
		if (exclude.includes(entry.name)) continue;
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			addWrittenFiles(writtenFiles, copyDirTracked(srcPath, destPath, { fsMod }));
		} else {
			fsMod.copyFileSync(srcPath, destPath);
			addWrittenFile(writtenFiles, destPath);
		}
	}
	return writtenFiles;
}

export function collectFilesRecursive(dir, fsMod = fs) {
	if (!fsMod.existsSync(dir)) return [];
	if (typeof fsMod.readdirSync !== 'function') {
		const store = fsMod._store;
		if (!store || typeof store !== 'object') return [];
		const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
		return Object.entries(store)
			.filter(([key, value]) => key.startsWith(prefix) && value !== '__dir__')
			.map(([key]) => path.resolve(key));
	}
	const result = [];
	for (const entry of fsMod.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			result.push(...collectFilesRecursive(full, fsMod));
		} else {
			result.push(path.resolve(full));
		}
	}
	return result;
}