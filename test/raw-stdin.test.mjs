import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { interceptRawStdin } from "../lib/raw-stdin.ts";
import { PASTE_END, PASTE_START } from "../lib/paste.ts";
import { pngBytes, gifBytes } from "./fixtures.mjs";

function harness() {
	const stream = new EventEmitter();
	const seen = [];
	// Stand in for pi's stdin handler: record everything it is given.
	stream.on("data", (chunk) => {
		seen.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "latin1"));
	});
	const images = [];
	const overflows = [];
	const interceptor = interceptRawStdin(stream, {
		onImage: (bytes, mimeType) => images.push({ bytes: Buffer.from(bytes), mimeType }),
		onOverflow: (bytes) => overflows.push(bytes),
	});
	return {
		stream,
		seen,
		images,
		overflows,
		interceptor,
		send: (data) => stream.emit("data", Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1")),
		joined: () => Buffer.concat(seen),
	};
}

const wrap = (payload) => Buffer.concat([Buffer.from(PASTE_START, "latin1"), Buffer.from(payload, "latin1"), Buffer.from(PASTE_END, "latin1")]);

test("keystrokes and text pastes reach the original listener untouched", () => {
	const h = harness();
	h.send("hello");
	h.send(wrap("pasted text"));
	h.send("\x16");
	// The paste reaches the parser with its markers, exactly as it would without us.
	assert.equal(h.joined().toString("utf8"), "hello" + PASTE_START + "pasted text" + PASTE_END + "\x16");
	assert.equal(h.images.length, 0);
	h.interceptor.restore();
});

test("an image paste is captured and never reaches the editor", () => {
	const h = harness();
	h.send("a");
	const png = pngBytes(1440, 900);
	h.send(wrap(png));
	h.send("b");
	assert.equal(h.joined().toString("utf8"), "ab");
	assert.equal(h.images.length, 1);
	assert.equal(h.images[0].mimeType, "image/png");
	assert.equal(Buffer.compare(Buffer.from(h.images[0].bytes), Buffer.from(png)), 0);
	h.interceptor.restore();
});

test("an image paste split across chunks is reassembled", () => {
	const h = harness();
	const png = gifBytes(800, 600);
	const whole = wrap(png);
	h.send(whole.subarray(0, 7)); // marker only
	h.send(whole.subarray(7, 9)); // one byte of payload
	h.send(whole.subarray(9, 20));
	h.send(whole.subarray(20));
	assert.equal(h.images.length, 1);
	assert.equal(Buffer.compare(Buffer.from(h.images[0].bytes), Buffer.from(png)), 0);
	assert.equal(h.images[0].mimeType, "image/gif");
	assert.equal(h.joined().length, 0);
	h.interceptor.restore();
});

test("a marker glued to a keystroke is left to the downstream parser", () => {
	const h = harness();
	const mixed = Buffer.concat([Buffer.from("x", "latin1"), wrap("text")]);
	h.send(mixed);
	assert.deepEqual(h.joined(), mixed);
	h.interceptor.restore();
});

test("a non-image paste is replayed with its markers intact", () => {
	const h = harness();
	const text = wrap("a longer paste of ordinary text");
	h.send(text);
	assert.deepEqual(h.joined(), text);
	assert.equal(h.images.length, 0);
	h.interceptor.restore();
});

test("an image paste with trailing input hands the trailing bytes on", () => {
	const h = harness();
	const combined = Buffer.concat([wrap(pngBytes()), Buffer.from("tail", "latin1")]);
	h.send(combined);
	assert.equal(h.joined().toString("utf8"), "tail");
	assert.equal(h.images.length, 1);
	h.interceptor.restore();
});

test("a paste that is not an image but looks binary still reaches the parser", () => {
	const h = harness();
	const payload = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(40, 0x7f)]);
	h.send(wrap(payload));
	assert.equal(h.images.length, 0);
	assert.deepEqual(h.joined(), wrap(payload));
	h.interceptor.restore();
});

test("an oversized paste is given up on and streamed through", () => {
	const h = harness();
	const interceptor = interceptRawStdin(h.stream, { onImage: () => {}, onOverflow: () => {}, maxImageBytes: 32 });
	assert.equal(interceptor.active, true);
	h.send(Buffer.from(PASTE_START, "latin1"));
	h.send(Buffer.alloc(64, 0x61));
	h.send(Buffer.concat([Buffer.alloc(8, 0x62), Buffer.from(PASTE_END, "latin1")]));
	// Everything after the give-up point is forwarded, and the stream recovers.
	assert.ok(h.joined().length > 0);
	h.send("after");
	assert.equal(h.joined().toString("latin1").endsWith("after"), true);
	h.interceptor.restore();
});

test("restore puts the original listeners back and stops interception", () => {
	const h = harness();
	const interceptor = h.interceptor;
	assert.equal(interceptor.active, true);
	interceptor.restore();
	h.send(wrap(pngBytes()));
	// After restore the original listener sees the paste again.
	assert.equal(h.joined().length, wrap(pngBytes()).length);
	assert.equal(h.images.length, 0);
	interceptor.restore(); // idempotent
	assert.equal(stream_listener_count(h.stream), 1);
});

function stream_listener_count(stream) {
	return stream.listenerCount("data");
}

test("interception is skipped when there is nothing to take over", () => {
	const stream = new EventEmitter();
	const interceptor = interceptRawStdin(stream, { onImage: () => {} });
	assert.equal(interceptor.active, false);
	interceptor.restore();
	assert.equal(stream.listenerCount("data"), 0);
});

test("heldBytes reports what is currently withheld", () => {
	const h = harness();
	assert.equal(h.interceptor.heldBytes, 0);
	h.send(Buffer.from(PASTE_START, "latin1"));
	assert.equal(h.interceptor.heldBytes, 0);
	// Too few bytes to recognise a format yet, so they stay withheld.
	h.send(Buffer.alloc(4, 0x89));
	assert.equal(h.interceptor.heldBytes, 4);
	h.send(Buffer.from(PASTE_END, "latin1"));
	assert.equal(h.interceptor.heldBytes, 0);
	// Undecidable bytes are released as an ordinary paste.
	assert.equal(h.joined().length, PASTE_START.length + 4 + PASTE_END.length);
	h.interceptor.restore();
});
