#!/usr/bin/env node
'use strict';

// Checks a security audit's findings.json against its human report.
// Usage: node validate-findings.cjs <findings.json> <report.md>
// Exit codes: 0 valid, 1 validation errors, 2 usage or unreadable input.
// Node built-ins only.

const fs = require('node:fs');

const VERDICTS = ['confirmed', 'needs-validation', 'rejected'];
const SEVERITIES = ['Critical', 'Required', 'Nit', 'Optional', 'FYI'];
const CATEGORIES = [
	'hardcoded-credentials',
	'injection',
	'auth-backdoor',
	'insecure-config-default',
	'weak-credential-storage',
	'ai-llm',
	'supply-chain-ci',
	'authz-isolation',
];

function isText(value) {
	return typeof value === 'string' && value.trim() !== '';
}

function validateRecords(data) {
	const errors = [];
	const records = data && Array.isArray(data.findings) ? data.findings : null;
	if (!records) {
		return {
			errors: ['findings.json must be an object with a "findings" array'],
			records: [],
		};
	}
	const seen = new Set();
	records.forEach((rec, i) => {
		const label = `record ${i + 1}`;
		if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
			errors.push(`${label}: must be an object`);
			return;
		}
		const hasId = isText(String(rec.id ?? ''));
		const name = hasId ? `id ${rec.id}` : label;
		if (!hasId) {
			errors.push(`${label}: missing id`);
		} else if (seen.has(String(rec.id))) {
			errors.push(`${name}: duplicate id`);
		} else {
			seen.add(String(rec.id));
		}
		if (!CATEGORIES.includes(rec.category)) {
			errors.push(`${name}: category must be one of ${CATEGORIES.join(', ')}`);
		}
		const loc = rec.location;
		if (!loc || !isText(loc.file)) {
			errors.push(`${name}: missing location.file`);
		}
		if (!loc || !Number.isInteger(loc.line) || loc.line < 1) {
			errors.push(`${name}: location.line must be a positive integer`);
		}
		if (!isText(rec.evidence)) errors.push(`${name}: missing evidence`);
		if (!VERDICTS.includes(rec.verdict)) {
			errors.push(`${name}: verdict must be one of ${VERDICTS.join(', ')}`);
			return;
		}
		if (rec.verdict === 'confirmed') {
			if (!SEVERITIES.includes(rec.severity)) {
				errors.push(
					`${name}: confirmed needs severity, one of ${SEVERITIES.join(', ')}`,
				);
			}
		} else if (rec.severity !== undefined && rec.severity !== null) {
			errors.push(`${name}: ${rec.verdict} must not have a severity`);
		}
		if (rec.verdict === 'needs-validation' && !isText(rec.unresolvedFact)) {
			errors.push(`${name}: needs-validation requires unresolvedFact`);
		}
		if (rec.verdict === 'rejected' && !isText(rec.reason)) {
			errors.push(`${name}: rejected requires reason`);
		}
	});
	return { errors, records };
}

function splitRow(line) {
	return line
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split(/(?<!\\)\|/)
		.map((c) => c.trim());
}

// Reads the table whose header has both "#" and "Verdict" columns.
function parseReport(markdown) {
	const lines = markdown.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].trim().startsWith('|')) continue;
		const header = splitRow(lines[i]).map((c) => c.toLowerCase());
		const idCol = header.indexOf('#');
		const verdictCol = header.indexOf('verdict');
		if (idCol < 0 || verdictCol < 0) continue;
		const rows = [];
		for (let j = i + 1; j < lines.length; j++) {
			if (!lines[j].trim().startsWith('|')) break;
			const cells = splitRow(lines[j]);
			if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
			rows.push({ id: cells[idCol], verdict: cells[verdictCol] });
		}
		return rows;
	}
	return null;
}

function compareToReport(records, rows) {
	if (!rows) {
		return ['report has no table with "#" and "Verdict" columns'];
	}
	const errors = [];
	const reportById = new Map();
	for (const row of rows) {
		if (reportById.has(row.id)) errors.push(`report: duplicate id ${row.id}`);
		reportById.set(row.id, String(row.verdict || '').toLowerCase());
	}
	const fileById = new Map(records.map((r) => [String(r.id), r.verdict]));
	for (const id of fileById.keys()) {
		if (!reportById.has(id)) {
			errors.push(`id ${id}: in findings.json, not in report`);
		}
	}
	for (const id of reportById.keys()) {
		if (!fileById.has(id)) {
			errors.push(`id ${id}: in report, not in findings.json`);
		}
	}
	for (const [id, verdict] of fileById) {
		if (reportById.has(id) && reportById.get(id) !== verdict) {
			errors.push(
				`id ${id}: verdict is "${verdict}" in findings.json but "${reportById.get(id)}" in report`,
			);
		}
	}
	return errors;
}

function validate(data, reportMarkdown) {
	const { errors, records } = validateRecords(data);
	if (reportMarkdown !== undefined) {
		errors.push(...compareToReport(records, parseReport(reportMarkdown)));
	}
	return errors;
}

function main(argv) {
	const [findingsPath, reportPath] = argv;
	if (!findingsPath || !reportPath || argv.length > 2) {
		process.stderr.write(
			'Usage: node validate-findings.cjs <findings.json> <report.md>\n',
		);
		return 2;
	}
	let data;
	let report;
	try {
		data = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
		report = fs.readFileSync(reportPath, 'utf8');
	} catch (err) {
		process.stderr.write(`Cannot read input: ${err.message}\n`);
		return 2;
	}
	const errors = validate(data, report);
	if (errors.length > 0) {
		process.stderr.write(`FAIL: ${errors.length} problem(s)\n`);
		for (const e of errors) process.stderr.write(`- ${e}\n`);
		return 1;
	}
	process.stdout.write(
		`OK: ${data.findings.length} finding(s) valid and match the report\n`,
	);
	return 0;
}

module.exports = { validate, validateRecords, parseReport, compareToReport };

if (require.main === module) {
	process.exitCode = main(process.argv.slice(2));
}
