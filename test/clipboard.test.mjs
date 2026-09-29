import { test } from "node:test";
import assert from "node:assert/strict";

import { isWaylandSession, readClipboardImage, readClipboardText } from "../lib/clipboard.ts";
import { pngBytes, jpegBytes } from "./fixtures.mjs";

/** Records the commands a backend would run and replies from a script. */
/** @param {Record<string, Buffer | undefined>} script */
function fakeExec(script) {
	const calls = [];
	const exec = async (command, args) => {
		calls.push([command, ...args].join(" "));
		return script[`${command} ${args[0] ?? ""}`.trim()] ?? script[command];
	};
	return { exec, calls };
}

test("a native clipboard image wins over every command backend", async () => {
	const { exec, calls } = fakeExec({});
	const image = await readClipboardImage({
		platform: "darwin",
		exec,
		nativeClipboard: () => ({ getText: async () => "", getImage: async () => pngBytes(64, 32) }),
	});
	assert.equal(image?.mimeType, "image/png");
	assert.equal(calls.length, 0);
});

test("a native clipboard without an image falls through to the platform backend", async () => {
	const { exec, calls } = fakeExec({ osascript: jpegBytes(20, 10) });
	const image = await readClipboardImage({
		platform: "darwin",
		exec,
		nativeClipboard: () => ({ getText: async () => "", getImage: async () => null }),
	});
	assert.equal(image?.mimeType, "image/jpeg");
	assert.deepEqual(calls, ["osascript -e get the clipboard as «class PNGf»", "osascript -e get the clipboard as «class JPEGf»"]);
});

test("an unavailable native clipboard is not an error", async () => {
	const { exec } = fakeExec({ osascript: pngBytes() });
	const image = await readClipboardImage({
		platform: "darwin",
		exec,
		nativeClipboard: () => {
			throw new Error("no display");
		},
	});
	assert.equal(image?.mimeType, "image/png");
});

test("a native payload in an unknown format does not stop the search", async () => {
	const { exec, calls } = fakeExec({ osascript: pngBytes() });
	const image = await readClipboardImage({
		platform: "darwin",
		exec,
		nativeClipboard: () => ({ getText: async () => "", getImage: async () => Uint8Array.from([0x42, 0x4d, 0x00, 0x00]) }),
	});
	assert.equal(image?.mimeType, "image/png");
	assert.ok(calls.length > 0);
});

test("macOS asks osascript for a PNG and accepts an empty clipboard", async () => {
	const { exec, calls } = fakeExec({ osascript: Buffer.alloc(0) });
	const image = await readClipboardImage({ platform: "darwin", exec, nativeClipboard: () => undefined });
	assert.equal(image, null);
	assert.deepEqual(calls, ["osascript -e get the clipboard as «class PNGf»", "osascript -e get the clipboard as «class JPEGf»"]);
});

test("a missing osascript means no image, not a crash", async () => {
	const image = await readClipboardImage({ platform: "darwin", exec: async () => undefined, nativeClipboard: () => undefined });
	assert.equal(image, null);
});

test("wayland prefers the type the clipboard advertises", async () => {
	const script = {
		"wl-paste --list-types": Buffer.from("text/plain\nimage/png\n"),
		"wl-paste --type": pngBytes(8, 4),
	};
	const { exec, calls } = fakeExec(script);
	const image = await readClipboardImage({
		platform: "linux",
		env: { WAYLAND_DISPLAY: "wayland-0" },
		exec,
		nativeClipboard: () => undefined,
	});
	assert.equal(image?.mimeType, "image/png");
	assert.deepEqual(calls, ["wl-paste --list-types", "wl-paste --type image/png --no-newline"]);
});

test("an empty wayland clipboard does not fall back to x11", async () => {
	const script = { "wl-paste --list-types": Buffer.from("text/plain\n") };
	const { exec, calls } = fakeExec(script);
	const image = await readClipboardImage({
		platform: "linux",
		env: { XDG_SESSION_TYPE: "wayland" },
		exec,
		nativeClipboard: () => undefined,
	});
	assert.equal(image, null);
	assert.deepEqual(calls, ["wl-paste --list-types"]);
});

test("x11 without a target list tries the known types in order", async () => {
	const exec = async (command, args) => {
		if (args.includes("TARGETS")) return undefined;
		if (args.includes("image/png")) return Buffer.from("not an image");
		if (args.includes("image/jpeg")) return jpegBytes(30, 20);
		return undefined;
	};
	const image = await readClipboardImage({ platform: "linux", env: {}, exec, nativeClipboard: () => undefined });
	assert.equal(image?.mimeType, "image/jpeg");
});

test("a payload that is not a supported image is rejected", async () => {
	const { exec } = fakeExec({ osascript: Buffer.from("%PDF-1.7 not an image at all") });
	const image = await readClipboardImage({ platform: "darwin", exec, nativeClipboard: () => undefined });
	assert.equal(image, null);
});

test("termux has no clipboard to read", async () => {
	const { exec, calls } = fakeExec({});
	const image = await readClipboardImage({
		platform: "linux",
		env: { TERMUX_VERSION: "0.119" },
		exec,
		nativeClipboard: () => undefined,
	});
	assert.equal(image, null);
	assert.deepEqual(calls, []);
});

test("clipboard text prefers the native helper", async () => {
	const { exec, calls } = fakeExec({ pbpaste: Buffer.from("from pbpaste") });
	const text = await readClipboardText({
		platform: "darwin",
		exec,
		nativeClipboard: () => ({ getText: async () => "from native", getImage: async () => null }),
	});
	assert.equal(text, "from native");
	assert.deepEqual(calls, []);
});

test("clipboard text falls back to the platform command", async () => {
	const { exec, calls } = fakeExec({ pbpaste: Buffer.from("from pbpaste") });
	assert.equal(await readClipboardText({ platform: "darwin", exec, nativeClipboard: () => undefined }), "from pbpaste");
	assert.deepEqual(calls, ["pbpaste"]);
});

test("an empty or failing clipboard yields null text", async () => {
	assert.equal(await readClipboardText({ platform: "darwin", exec: async () => Buffer.alloc(0) }), null);
	assert.equal(await readClipboardText({ platform: "darwin", exec: async () => undefined }), null);
});

test("isWaylandSession reads both signals", () => {
	assert.equal(isWaylandSession({ WAYLAND_DISPLAY: "wayland-0" }), true);
	assert.equal(isWaylandSession({ XDG_SESSION_TYPE: "wayland" }), true);
	assert.equal(isWaylandSession({ XDG_SESSION_TYPE: "x11" }), false);
	assert.equal(isWaylandSession({}), false);
});
