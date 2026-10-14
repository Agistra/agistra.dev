import fs from 'node:fs';
import path from 'node:path';

export const IGNORE = new Set([
	'node_modules',
	'.git',
	'dist',
	'out',
	'build',
	'coverage',
	'.vscode-test',
]);
export const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py']);
export const MAX_FILE_LINES = 300;
export const MAX_DIR_FILES = 20;

export function r(n) {
	return Math.round(n * 100) / 100;
}

export function walkDir(dir, fn) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (IGNORE.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkDir(full, fn);
		else fn(full);
	}
}

export function countLines(filePath) {
	try {
		return fs.readFileSync(filePath, 'utf-8').split('\n').length;
	} catch {
		return 0;
	}
}

export function collectSourceFiles(root) {
	const files = [];
	walkDir(root, (f) => {
		if (SOURCE_EXTS.has(path.extname(f))) files.push(f);
	});
	return files;
}
