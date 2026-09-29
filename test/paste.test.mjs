import { test } from "node:test";
import assert from "node:assert/strict";

import {
	defaultPasteChordKeys,
	extractImagePaths,
	isPasteChord,
	looksBinary,
	PASTE_END,
	PASTE_START,
	splitPasteSequence,
} from "../lib/paste.ts";

test("splitPasteSequence extracts a complete bracketed paste", () => {
	assert.deepEqual(splitPasteSequence(`${PASTE_START}hello${PASTE_END}`), { before: "", payload: "hello", after: "" });
	assert.deepEqual(splitPasteSequence(`a${PASTE_START}hello${PASTE_END}b`), { before: "a", payload: "hello", after: "b" });
	assert.deepEqual(splitPasteSequence(`${PASTE_START}multi\nline${PASTE_END}`), {
		before: "",
		payload: "multi\nline",
		after: "",
	});
});

test("splitPasteSequence returns null when there is no complete paste", () => {
	assert.equal(splitPasteSequence("plain keystroke"), null);
	assert.equal(splitPasteSequence(`${PASTE_START}unterminated`), null);
	assert.equal(splitPasteSequence(""), null);
	assert.equal(splitPasteSequence(`${PASTE_END}orphan`), null);
});

test("isPasteChord consults the bound keys and survives matcher errors", () => {
	const sequences = { "ctrl+v": "\x16", "alt+v": "\x1bv" };
	const matches = (data, key) => data === sequences[key];
	assert.equal(isPasteChord("\x16", ["ctrl+v"], matches), true);
	assert.equal(isPasteChord("v", ["ctrl+v"], matches), false);
	assert.equal(isPasteChord("\x1bv", ["alt+v", "ctrl+v"], matches), true);
	assert.equal(isPasteChord("\x1bv", ["ctrl+v"], matches), false);
	assert.equal(isPasteChord("\x16", [], matches), false);
	assert.equal(isPasteChord("", ["ctrl+v"], matches), false);
	assert.equal(
		isPasteChord("\x16", ["ctrl+v"], () => {
			throw new Error("unknown key");
		}),
		false,
	);
});

test("defaultPasteChordKeys follows pi's per-platform defaults", () => {
	assert.deepEqual(defaultPasteChordKeys("darwin"), ["ctrl+v"]);
	assert.deepEqual(defaultPasteChordKeys("linux"), ["ctrl+v"]);
	assert.deepEqual(defaultPasteChordKeys("win32"), ["alt+v"]);
});

test("looksBinary separates text from undecodable payloads", () => {
	assert.equal(looksBinary(""), false);
	assert.equal(looksBinary("hello\tworld\n"), false);
	assert.equal(looksBinary("[31mred[0m text"), false);
	assert.equal(looksBinary("a\u0000b"), true);
	assert.equal(looksBinary("\u0001\u0002\u0003\u0004\u0005\u0006\u0007\b"), true);
	assert.equal(looksBinary("plain"), false);
});

test("extractImagePaths only accepts pure image path payloads", () => {
	assert.deepEqual(extractImagePaths("/tmp/a.png"), ["/tmp/a.png"]);
	assert.deepEqual(extractImagePaths("/tmp/a.png\n/tmp/b.jpg\n"), ["/tmp/a.png", "/tmp/b.jpg"]);
	assert.deepEqual(extractImagePaths("/tmp/my\\ shot.png"), ["/tmp/my shot.png"]);
	assert.deepEqual(extractImagePaths('"/tmp/my shot.png"'), ["/tmp/my shot.png"]);
	assert.deepEqual(extractImagePaths("'/tmp/my shot.png'"), ["/tmp/my shot.png"]);
	assert.deepEqual(extractImagePaths("'/tmp/Screenshot 2026-09-29 at 18-37-57.png'"), [
		"/tmp/Screenshot 2026-09-29 at 18-37-57.png",
	]);
	assert.deepEqual(extractImagePaths("'/tmp/a b.png' \"/tmp/c d.jpg\""), ["/tmp/a b.png", "/tmp/c d.jpg"]);
	assert.deepEqual(extractImagePaths("/tmp/a.png /tmp/b.webp"), ["/tmp/a.png", "/tmp/b.webp"]);
	assert.deepEqual(extractImagePaths("  /tmp/a.png  "), ["/tmp/a.png"]);
	assert.deepEqual(extractImagePaths("/tmp/a.png notes.txt"), []);
	assert.deepEqual(extractImagePaths("look at this"), []);
	assert.deepEqual(extractImagePaths(""), []);
	assert.deepEqual(extractImagePaths("   \n  "), []);
});
