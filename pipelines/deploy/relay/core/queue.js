import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** @typedef {import('./adapter-contract.js').InboundJob} InboundJob */

/**
 * Durable file-backed inbound queue at `<hub>/relay/inbox/<uuid>.json`.
 */
export class InboundQueue {
	/**
	 * @param {object} options
	 * @param {string} options.hubRoot
	 * @param {typeof fs} [options.fsMod]
	 */
	constructor({ hubRoot, fsMod = fs }) {
		this.hubRoot = path.resolve(hubRoot);
		this.fsMod = fsMod;
		this.inboxDir = path.join(this.hubRoot, 'relay', 'inbox');
		this.fsMod.mkdirSync(this.inboxDir, { recursive: true });
	}

	/**
	 * @param {Omit<InboundJob, 'id' | 'status' | 'received_at'> & { id?: string }} fields
	 * @returns {InboundJob}
	 */
	enqueue(fields) {
		const job = {
			id: fields.id ?? randomUUID(),
			status: 'pending',
			received_at: new Date().toISOString(),
			...fields,
		};
		this._writeJob(job);
		return job;
	}

	/**
	 * Return oldest pending job and mark it processing.
	 *
	 * @returns {InboundJob | null}
	 */
	peekNext() {
		const pending = this._listByStatus('pending')
			.sort((a, b) => a.received_at.localeCompare(b.received_at));
		if (pending.length === 0) return null;
		const job = { ...pending[0], status: 'processing' };
		this._writeJob(job);
		return job;
	}

	/**
	 * @param {string} jobId
	 * @returns {InboundJob}
	 */
	ack(jobId) {
		const job = this._readJob(jobId);
		if (!job) {
			throw new Error(`inbox job not found: ${jobId}`);
		}
		job.status = 'done';
		this._writeJob(job);
		return job;
	}

	pendingCount() {
		return this._listByStatus('pending').length;
	}

	stats() {
		const all = this._listAll();
		return {
			pending: all.filter(j => j.status === 'pending').length,
			processing: all.filter(j => j.status === 'processing').length,
			done: all.filter(j => j.status === 'done').length,
			failed: all.filter(j => j.status === 'failed').length,
		};
	}

	/**
	 * Reset processing jobs whose received_at is older than processingTimeoutMs.
	 * Returns the count of jobs reset to 'pending'.
	 *
	 * @param {number} processingTimeoutMs
	 * @returns {number}
	 */
	resetStaleProcessing(processingTimeoutMs) {
		const now = Date.now();
		const stale = this._listAll().filter(
			j => j.status === 'processing'
				&& now - new Date(j.received_at).getTime() > processingTimeoutMs,
		);
		for (const job of stale) {
			this._writeJob({ ...job, status: 'pending' });
		}
		return stale.length;
	}

	/**
	 * Delete done jobs whose received_at is older than olderThanMs.
	 * Pending and processing jobs are never deleted.
	 * Non-fatal on individual delete errors.
	 * Returns count of deleted files.
	 *
	 * @param {number} olderThanMs
	 * @returns {number}
	 */
	pruneOldDone(olderThanMs) {
		const now = Date.now();
		const old = this._listAll().filter(
			j => j.status === 'done'
				&& now - new Date(j.received_at).getTime() > olderThanMs,
		);
		let count = 0;
		for (const job of old) {
			try {
				this.fsMod.unlinkSync(this._jobPath(job.id));
				count++;
			} catch {
				// non-fatal
			}
		}
		return count;
	}

	clear() {
		for (const file of this.fsMod.readdirSync(this.inboxDir)) {
			if (file.endsWith('.json')) {
				this.fsMod.unlinkSync(path.join(this.inboxDir, file));
			}
		}
	}

	_jobPath(id) {
		return path.join(this.inboxDir, `${id}.json`);
	}

	_writeJob(job) {
		this.fsMod.writeFileSync(this._jobPath(job.id), JSON.stringify(job, null, 2) + '\n', 'utf-8');
	}

	_readJob(id) {
		const filePath = this._jobPath(id);
		if (!this.fsMod.existsSync(filePath)) return null;
		try {
			return JSON.parse(this.fsMod.readFileSync(filePath, 'utf-8'));
		} catch {
			return null;
		}
	}

	_listAll() {
		if (!this.fsMod.existsSync(this.inboxDir)) return [];
		return this.fsMod.readdirSync(this.inboxDir)
			.filter(f => f.endsWith('.json'))
			.map(f => {
				try {
					return JSON.parse(this.fsMod.readFileSync(path.join(this.inboxDir, f), 'utf-8'));
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	}

	_listByStatus(status) {
		return this._listAll().filter(j => j.status === status);
	}
}
