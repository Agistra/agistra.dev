/**
 * status-fields.js — the optional ticket fields `npm run status` reads.
 *
 * `queue`, `go`, `waiting_on` and `ask` are optional front matter. A ticket
 * without them is valid and behaves as before. They are written through
 * `task update-field`, which calls `normalizeTicketField` so a bad value is
 * refused before the file is touched.
 *
 * This is the one file that names the people a ticket can wait on, so the
 * rest of the code never spells them out.
 */

/** Who a ticket can be waiting on, besides an outside party (`external:<who>`). */
export const WAITING_ON_PEOPLE = ['team-lead', 'cao'];

/** Names of the optional ticket fields this module validates. */
export const TICKET_STATUS_FIELDS = ['queue', 'go', 'waiting_on', 'ask'];

/**
 * The people a ticket can wait on in a hub with these agents: the team lead
 * always, and each other named person only when the hub has that agent.
 */
export function waitingOnPeople(agents = []) {
	if (agents.length === 0) return WAITING_ON_PEOPLE;
	return WAITING_ON_PEOPLE.filter(
		(p) => p === 'team-lead' || agents.includes(p),
	);
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(text) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
	if (!m) return false;
	const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
	return (
		d.getUTCFullYear() === +m[1] &&
		d.getUTCMonth() === +m[2] - 1 &&
		d.getUTCDate() === +m[3]
	);
}

/** Strip one pair of surrounding double or single quotes. */
export function unquoteValue(value) {
	const text = String(value ?? '').trim();
	const m = /^(["'])([\s\S]*)\1$/.exec(text);
	return m ? m[2] : text;
}

/**
 * Validate and normalise a value for one of the optional ticket fields.
 * An empty value clears the field. Any other field passes through unchanged.
 *
 * `agents` is the list of agents the hub has. `cao` is only accepted for
 * `waiting_on` when the hub has that agent; an empty or missing list keeps the
 * full set of names.
 *
 * @param {string} field
 * @param {unknown} value
 * @param {{ agents?: string[] }} [opts]
 * @returns {{ ok: true, value: string|null|undefined } | { ok: false, error: string }}
 */
export function normalizeTicketField(field, value, { agents = [] } = {}) {
	if (!TICKET_STATUS_FIELDS.includes(field)) {
		return { ok: true, value: undefined };
	}
	const text = String(value ?? '').trim();
	if (text === '') return { ok: true, value: null };
	switch (field) {
		case 'queue':
			return /^\d+$/.test(text)
				? { ok: true, value: String(parseInt(text, 10)) }
				: {
						ok: false,
						error: `queue must be a whole number (order within the project); got ${JSON.stringify(text)}`,
					};
		case 'go':
			return isIsoDate(text)
				? { ok: true, value: text }
				: {
						ok: false,
						error: `go must be a date written YYYY-MM-DD; got ${JSON.stringify(text)}`,
					};
		case 'waiting_on': {
			const people = waitingOnPeople(agents);
			if (people.includes(text) || /^external:\S/.test(text)) {
				return { ok: true, value: text };
			}
			return {
				ok: false,
				error: `waiting_on must be ${people.join(', ')} or external:<who>; got ${JSON.stringify(text)}`,
			};
		}
		default: {
			// ask: one line, stored quoted so a colon in it stays valid front matter.
			if (/[\r\n]/.test(text)) {
				return { ok: false, error: 'ask must be a single line' };
			}
			return { ok: true, value: JSON.stringify(unquoteValue(text)) };
		}
	}
}

/**
 * Where a `waiting_on` value sends the ticket in the status:
 * `needs_you` for the team lead or the CAO, `external` for an outside party,
 * null for anything else.
 */
export function routeWaitingOn(value) {
	const text = String(value ?? '').trim();
	if (WAITING_ON_PEOPLE.includes(text)) return 'needs_you';
	return /^external:\S/.test(text) ? 'external' : null;
}
