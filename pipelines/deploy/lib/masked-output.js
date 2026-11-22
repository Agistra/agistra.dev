/**
 * An output stream that can hide what readline echoes while a secret is typed.
 *
 * readline echoes every typed character by writing to its output stream. Older
 * Node versions let a caller override `rl._writeToOutput`; current ones do not
 * expose it, so the only stable hook is the stream itself. Give readline the
 * object this returns instead of the raw stream, then call `beginMask(prompt)`
 * before `rl.question(prompt)` and `endMask()` after it: the prompt and the
 * closing newline are written through, everything else (the typed characters,
 * cursor redraws) is dropped.
 *
 * Everything other than `write` is delegated to the wrapped stream, so columns,
 * isTTY, resize events and so on behave as before.
 *
 * @param {import('node:stream').Writable} stream
 */
export function createMaskableOutput(stream) {
	let masking = null;
	const write = (chunk, ...rest) => {
		if (masking) {
			const text = String(chunk);
			if (!masking.promptShown) {
				masking.promptShown = text.includes(masking.prompt);
			} else if (text !== '\r\n' && text !== '\n') {
				return true;
			}
		}
		return stream.write(chunk, ...rest);
	};
	return new Proxy(stream, {
		get(target, key) {
			if (key === 'write') return write;
			if (key === 'beginMask') {
				return (prompt) => {
					masking = { prompt, promptShown: false };
				};
			}
			if (key === 'endMask') {
				return () => {
					masking = null;
				};
			}
			const value = Reflect.get(target, key, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}
