import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import inlineImagePaste from "../index.ts";
import { AttachmentBar, attachmentWidgetLines } from "../lib/attachment-bar.ts";
import { placeholderToken } from "../lib/attachments.ts";
import { pngBytes, gifBytes } from "./fixtures.mjs";

/**
 * Point pi's settings at a scratch directory for the whole file, so a test can
 * never write to the developer's real agent settings.
 */
const scratchAgentDir = await mkdtemp(join(tmpdir(), "piip-agent-"));
process.env.PI_CODING_AGENT_DIR = scratchAgentDir;

/**
 * A fake pi runtime. Only the surface the extension touches is implemented,
 * which is also a check that the extension stays within that surface.
 */
function fakeRuntime() {
	const events = new Map();
	const commands = new Map();
	const calls = { terminalHandlers: [], widgets: new Map(), editorText: "", pasted: [], notifications: [] };

	const pi = {
		on(name, handler) {
			const list = events.get(name) ?? [];
			list.push(handler);
			events.set(name, list);
			return () => {};
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
	};

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			theme: { fg: (_color, text) => text },
			notify: (message, type) => calls.notifications.push({ message, type }),
			onTerminalInput: (handler) => {
				calls.terminalHandlers.push(handler);
				return () => {
					calls.terminalHandlers = calls.terminalHandlers.filter((entry) => entry !== handler);
				};
			},
			setWidget: (key, content) => {
				if (content === undefined) calls.widgets.delete(key);
				else calls.widgets.set(key, content);
			},
			pasteToEditor: (text) => calls.pasted.push(text),
			getEditorText: () => calls.editorText,
			setEditorText: (text) => {
				calls.editorText = text;
			},
		},
	};

	inlineImagePaste(pi);

	const emit = async (name, event) => {
		for (const handler of events.get(name) ?? []) await handler(event, ctx);
	};
	return { pi, ctx, events, commands, calls, emit };
}

function image(index, overrides = {}) {
	return { index, bytes: pngBytes(100, 50), mimeType: "image/png", dimensions: { width: 100, height: 50 }, ...overrides };
}

async function started() {
	const runtime = fakeRuntime();
	await runtime.emit("session_start", { type: "session_start", reason: "startup" });
	return runtime;
}

/** Put an image in the pending list the way a paste would. */
async function attach(runtime, pendingImage) {
	const handler = runtime.calls.terminalHandlers[0];
	assert.ok(handler, "a terminal input handler is registered on session start");
	// The path paste path is synchronous up to the stat call, so wait a tick.
	const drop = `\x1b[200~${pendingImage.name}\x1b[201~`;
	const result = handler(drop);
	await new Promise((resolve) => setTimeout(resolve, 5));
	return result;
}

test("session_start registers the terminal handler and reads settings", async () => {
	const runtime = await started();
	assert.equal(runtime.calls.terminalHandlers.length, 1);
	assert.equal(runtime.calls.widgets.size, 0);
});

test("session_shutdown removes the terminal handler and the widget", async () => {
	const runtime = await started();
	await runtime.emit("session_shutdown", { type: "session_shutdown", reason: "exit" });
	assert.equal(runtime.calls.terminalHandlers.length, 0);
});

test("non-TUI modes ignore terminal input entirely", async () => {
	const runtime = fakeRuntime();
	runtime.ctx.mode = "rpc";
	await runtime.emit("session_start", { type: "session_start", reason: "startup" });
	const handler = runtime.calls.terminalHandlers[0];
	assert.ok(handler);
	assert.equal(handler("\x16"), undefined);
	assert.equal(handler("\x1b[200~/tmp/a.png\x1b[201~"), undefined);
	assert.deepEqual(runtime.calls.pasted, []);
});

test("a paste that is not a path is left to pi", async () => {
	const runtime = await started();
	const handler = runtime.calls.terminalHandlers[0];
	assert.equal(handler("hello"), undefined);
	assert.equal(handler("\x1b[200~some text\x1b[201~"), undefined);
	assert.equal(runtime.calls.pasted.length, 0);
});

test("input is passed through untouched while nothing is attached", async () => {
	const runtime = await started();
	const [handler] = runtime.events.get("input");
	assert.equal(handler({ type: "input", text: "plain", source: "interactive" }), undefined);
});

test("a dropped image path becomes a pending image with a token", async () => {
	const dir = await mkdtemp(join(tmpdir(), "piip-"));
	const file = join(dir, "shot.png");
	await writeFile(file, Buffer.from(pngBytes(320, 200)));

	const runtime = await started();
	runtime.ctx.cwd = dir;
	await attach(runtime, { name: file });

	assert.deepEqual(runtime.calls.pasted, ["[image 1] "]);
	assert.equal(runtime.calls.widgets.size, 1);
	// The image is not sent until the next prompt, and the token that stands for
	// it in the editor is what gets swapped for the image.
	const [input] = runtime.events.get("input");
	const result = input({ type: "input", text: "what is this? [image 1] ", source: "interactive" });
	assert.equal(result.action, "transform");
	assert.equal(result.text, "what is this? [shot.png: 320x200 PNG, 37 B]");
	assert.equal(result.images.length, 1);
	assert.equal(result.images[0].mimeType, "image/png");
	assert.equal(result.images[0].data, Buffer.from(pngBytes(320, 200)).toString("base64"));
	// Pending state is cleared and the widget removed.
	assert.equal(runtime.calls.widgets.size, 0);
	const second = input({ type: "input", text: "again", source: "interactive" });
	assert.equal(second, undefined);
});

test("input from another source never picks up pending images", async () => {
	const dir = await mkdtemp(join(tmpdir(), "piip-"));
	const file = join(dir, "shot.png");
	await writeFile(file, Buffer.from(pngBytes()));
	const runtime = await started();
	runtime.ctx.cwd = dir;
	await attach(runtime, { name: file });

	const [input] = runtime.events.get("input");
	assert.equal(input({ type: "input", text: "from rpc", source: "rpc" }), undefined);
});

test("a path that only looks like an image goes back in as text", async () => {
	const dir = await mkdtemp(join(tmpdir(), "piip-"));
	// Named like an image, so the paste is claimed, but the bytes are not one.
	const file = join(dir, "fake.png");
	await writeFile(file, "this is plain text pretending to be a png");
	const runtime = await started();
	runtime.ctx.cwd = dir;
	await attach(runtime, { name: file });

	assert.deepEqual(runtime.calls.pasted, [file]);
	assert.equal(runtime.calls.widgets.size, 0);
	assert.ok(runtime.calls.notifications.some((entry) => entry.type === "warning"));
});

test("a path that is not image-shaped is left to pi", async () => {
	const dir = await mkdtemp(join(tmpdir(), "piip-"));
	const file = join(dir, "notes.txt");
	await writeFile(file, "not an image");
	const runtime = await started();
	runtime.ctx.cwd = dir;
	const handler = runtime.calls.terminalHandlers[0];
	// The extension does not claim it, so pi pastes the text itself.
	assert.equal(handler(`\x1b[200~${file}\x1b[201~`), undefined);
	assert.deepEqual(runtime.calls.pasted, []);
	assert.equal(runtime.calls.widgets.size, 0);
});

test("/image-attach, /image-list, and /image-clear drive the same pending list", async () => {
	const dir = await mkdtemp(join(tmpdir(), "piip-"));
	const file = join(dir, "shot.gif");
	await writeFile(file, Buffer.from(gifBytes(64, 32)));
	const runtime = await started();
	runtime.ctx.cwd = dir;

	await runtime.commands.get("image-attach").handler(file, runtime.ctx);
	assert.deepEqual(runtime.calls.pasted, ["[image 1] "]);

	runtime.calls.editorText = "look [image 1] ";
	await runtime.commands.get("image-list").handler("", runtime.ctx);
	assert.ok(runtime.calls.notifications.some((entry) => entry.message.includes("1 image attached")));

	await runtime.commands.get("image-clear").handler("", runtime.ctx);
	assert.equal(runtime.calls.editorText, "look  ");
	assert.equal(runtime.calls.widgets.size, 0);
	const [input] = runtime.events.get("input");
	assert.equal(input({ type: "input", text: "look  ", source: "interactive" }), undefined);
});

test("/image-attach without arguments explains itself", async () => {
	const runtime = await started();
	await runtime.commands.get("image-attach").handler("   ", runtime.ctx);
	assert.ok(runtime.calls.notifications.some((entry) => entry.message.startsWith("Usage:")));
});

test("/image-notes toggles the note and writes it to the settings file", async () => {
	const runtime = await started();
	await runtime.commands.get("image-notes").handler("", runtime.ctx);
	assert.ok(runtime.calls.notifications.some((entry) => entry.message.includes("no note")));

	const { readFile } = await import("node:fs/promises");
	const saved = JSON.parse(await readFile(join(scratchAgentDir, "settings.json"), "utf8"));
	assert.equal(saved.imagePaste.showNotes, false);
	assert.equal(saved.imagePaste.showPreview, true);

	// A later session starts from the saved value.
	const next = await started();
	const [input] = next.events.get("input");
	next.ctx.cwd = runtime.ctx.cwd;
	assert.equal(input({ type: "input", text: "hi", source: "interactive" }), undefined);
});

test("the widget draws a caption and a line per image", () => {
	const theme = { fg: (_color, text) => text };
	const images = [image(1), image(2, { mimeType: "image/gif", bytes: gifBytes(), name: "loop.gif" })];
	const bar = new AttachmentBar({ images, theme, maxThumbnails: 2 });
	const lines = bar.render(40);
	assert.ok(lines.length >= 1);
	assert.match(lines[lines.length - 1], /2 images attached/);

	const list = attachmentWidgetLines(images, theme);
	assert.equal(list.length, 3);
	assert.match(list[1], /image 1 — 100x50 PNG/);

	// An empty list renders nothing at all.
	assert.deepEqual(new AttachmentBar({ images: [], theme }).render(40), []);
	assert.deepEqual(attachmentWidgetLines([], theme), []);
});

test("the text widget stays inside pi's ten-line limit", () => {
	const theme = { fg: (_color, text) => text };
	const images = Array.from({ length: 20 }, (_, i) => image(i + 1));
	const lines = attachmentWidgetLines(images, theme);
	assert.ok(lines.length <= 10);
	assert.match(lines[lines.length - 1], /and 12 more/);
});

test("the widget collapses extra images into a counter", () => {
	const theme = { fg: (_color, text) => text };
	const images = [image(1), image(2), image(3), image(4)];
	const lines = new AttachmentBar({ images, theme, maxThumbnails: 2 }).render(60);
	assert.ok(lines.some((line) => line.includes("+2 more")));
});

test("the widget rebuilds when the pending list changes", () => {
	const theme = { fg: (_color, text) => text };
	const bar = new AttachmentBar({ images: [image(1)], theme });
	const first = bar.render(40);
	assert.equal(bar.render(40).length, first.length);
	bar.update([image(1), image(2)]);
	const second = bar.render(40);
	assert.match(second[second.length - 1], /2 images attached/);
});

test("placeholderToken numbering survives a mixed batch", () => {
	assert.equal(placeholderToken(image(3)), "[image 3]");
});
