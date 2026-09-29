/**
 * Terminal paste handling at the string level.
 *
 * pi's stdin buffer decodes every chunk as UTF-8 before it reaches the editor,
 * so raw image bytes cannot be recovered here — `lib/raw-stdin.ts` intercepts
 * those a level lower. What is left for this module is the decoded side: the
 * paste keybinding, and text pastes that are really dropped file paths.
 *
 * Pure logic: the caller performs the I/O.
 */

import { looksLikeImagePath } from "./images.ts";

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

export interface PasteSequence {
	/** Text before the opening marker. */
	before: string;
	/** The pasted content, without the markers. */
	payload: string;
	/** Text after the closing marker. */
	after: string;
}

/**
 * Split a decoded terminal sequence containing a complete bracketed paste.
 * Returns null when there is no complete paste in the sequence.
 */
export function splitPasteSequence(data: string): PasteSequence | null {
	const start = data.indexOf(PASTE_START);
	if (start === -1) return null;
	const contentStart = start + PASTE_START.length;
	const end = data.indexOf(PASTE_END, contentStart);
	if (end === -1) return null;
	return { before: data.slice(0, start), payload: data.slice(contentStart, end), after: data.slice(end + PASTE_END.length) };
}

/**
 * True when `data` matches one of the keys bound to the paste-image action.
 * The matcher is injected so this stays testable and so the caller can fall
 * back to raw sequences when pi's keybinding registry is unavailable.
 */
export function isPasteChord(data: string, keys: readonly string[], matchesKey: (data: string, key: string) => boolean): boolean {
	if (data.length === 0 || keys.length === 0) return false;
	return keys.some((key) => {
		try {
			return matchesKey(data, key);
		} catch {
			return false;
		}
	});
}

/** Default keys for `app.clipboard.pasteImage`, used when the registry is unavailable. */
export function defaultPasteChordKeys(platform: NodeJS.Platform = process.platform): string[] {
	return platform === "win32" ? ["alt+v"] : ["ctrl+v"];
}

/**
 * True when a payload is mostly C0 control characters, i.e. binary that no
 * supported decoder understood. Tab, newline, carriage return, and escape are
 * allowed because ordinary text pastes contain them.
 */
export function looksBinary(payload: string): boolean {
	if (payload.length === 0) return false;
	let control = 0;
	for (const char of payload) {
		const code = char.codePointAt(0)!;
		if (code === 0) return true;
		if (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 27) control++;
	}
	return control >= 8 && control / payload.length > 0.02;
}

/**
 * Split a pasted blob into candidate image file paths.
 *
 * Terminals escape spaces in dropped paths (`/tmp/my\ shot.png`) and some wrap
 * them in quotes, so both are unwrapped here. An empty result means the payload
 * is not purely path-shaped, which is the signal to treat it as text.
 */
export function extractImagePaths(payload: string): string[] {
	const lines = payload
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
	if (lines.length === 0) return [];
	const tokens = lines.flatMap(splitEscaped).map(unescapeToken).filter((token) => token !== "");
	if (tokens.length === 0) return [];
	return tokens.every((token) => looksLikeImagePath(token)) ? tokens : [];
}

/** Split on unescaped, unquoted whitespace, keeping escape sequences attached. */
function splitEscaped(line: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const char = line[i]!;
		if (char === "\\" && i + 1 < line.length) {
			current += char + line[i + 1];
			i++;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = quote === char ? null : (quote ?? char);
			current += char;
			continue;
		}
		if ((char === " " || char === "\t") && quote === null) {
			if (current !== "") out.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current !== "") out.push(current);
	return out;
}

/** Quote characters a shell or file manager wraps a path in. */
const QUOTES = new Set(['"', "'"]);

function unescapeToken(token: string): string {
	const quote = token[0];
	// macOS screenshot and file-manager apps copy paths in either quote style.
	const quoted = token.length > 1 && quote !== undefined && QUOTES.has(quote) && token.endsWith(quote);
	const body = quoted ? token.slice(1, -1) : token;
	return body.replace(/\\ /g, " ").replace(/\\(["'])/g, "$1").replace(/\\\\/g, "\\");
}
