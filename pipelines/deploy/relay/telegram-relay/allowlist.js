import fs from 'node:fs';
import path from 'node:path';
import { resolveMemoryRootForHub } from '../../lib/memory-root.js';

/**
 * @param {number | undefined} senderId
 * @param {string[]} allowedSenders
 * @returns {boolean}
 */
export function isAllowedSender(senderId, allowedSenders) {
	if (!allowedSenders || allowedSenders.length === 0) return true;
	if (senderId == null) return false;
	return allowedSenders.includes(String(senderId));
}

/**
 * Append unknown-sender escalation to the hub's router.md HOT section.
 *
 * Memory root is resolved via resolveMemoryRootForHub() (lib/memory-root.js)
 * so vault-backed tiers (dev:sub, ops) write to
 * <hubRoot>/vault/Memory/router.md instead of the free-tier
 * <hubRoot>/memory/router.md default — see the Storage Plugin Contract in
 * agents/skills/agent-foundations/SKILL.md.
 *
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {number | undefined} options.senderId
 * @param {string} options.rawText
 * @param {typeof fs} [options.fsMod]
 */
export function escalateUnknownSender({ hubRoot, senderId, rawText, fsMod = fs }) {
	const memPath = path.join(resolveMemoryRootForHub(hubRoot, { fsMod }), 'router.md');
	const stamp = new Date().toISOString().slice(0, 10);
	const snippet = (rawText || '(empty message)').replace(/\s+/g, ' ').slice(0, 160);
	const line = `- **${stamp} (relay):** Unknown sender \`${senderId ?? 'unknown'}\` — ${snippet}\n`;

	if (!fsMod.existsSync(memPath)) {
		fsMod.mkdirSync(path.dirname(memPath), { recursive: true });
		fsMod.writeFileSync(memPath, `# router memory\n\n## HOT\n\n${line}\n## WARM\n\n## COLD\n\n`, 'utf-8');
		return;
	}

	let content = fsMod.readFileSync(memPath, 'utf-8');
	const hotHeader = '## HOT';
	const hotIdx = content.indexOf(hotHeader);
	if (hotIdx === -1) {
		content += `\n${hotHeader}\n\n${line}`;
	} else {
		const afterHot = hotIdx + hotHeader.length;
		const warmIdx = content.indexOf('## WARM', afterHot);
		const insertAt = warmIdx === -1 ? content.length : warmIdx;
		content = content.slice(0, insertAt).trimEnd() + `\n${line}\n` + content.slice(insertAt);
	}
	fsMod.writeFileSync(memPath, content, 'utf-8');
}
