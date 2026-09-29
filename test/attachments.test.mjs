import { test } from "node:test";
import assert from "node:assert/strict";

import {
	applyAttachments,
	attachmentNote,
	attachmentSummary,
	describeImage,
	placeholderToken,
	stripPlaceholders,
	unreferencedImages,
} from "../lib/attachments.ts";
import { pngBytes, gifBytes } from "./fixtures.mjs";

function image(index, overrides = {}) {
	return {
		index,
		bytes: pngBytes(100 + index, 50 + index),
		mimeType: "image/png",
		dimensions: { width: 100 + index, height: 50 + index },
		...overrides,
	};
}

test("placeholderToken numbers images from one", () => {
	assert.equal(placeholderToken(image(1)), "[image 1]");
	assert.equal(placeholderToken(image(7)), "[image 7]");
});

test("attachmentNote describes size, format, and weight", () => {
	assert.equal(attachmentNote(image(1)), "[pasted image: 101x51 PNG, 37 B]");
	assert.equal(attachmentNote(image(1, { name: "shot.png" })), "[shot.png: 101x51 PNG, 37 B]");
	assert.equal(attachmentNote(image(1, { dimensions: undefined, mimeType: "image/jpeg" })), "[pasted image: JPEG, 37 B]");
});

test("describeImage is a single readable line", () => {
	assert.equal(describeImage(image(2, { name: "a.gif", mimeType: "image/gif" })), "a.gif — 102x52 GIF, 37 B");
	assert.equal(describeImage(image(3, { dimensions: undefined })), "image 3 — PNG, 37 B");
});

test("attachmentSummary counts images and total weight", () => {
	assert.equal(attachmentSummary([]), "");
	assert.equal(attachmentSummary([image(1)]), "1 image attached · 37 B · /image-clear to remove");
	assert.equal(attachmentSummary([image(1), image(2)]), "2 images attached · 74 B · /image-clear to remove");
});

test("tokens are replaced in place by their note", () => {
	const result = applyAttachments("compare [image 1] with [image 2] please", [image(1), image(2)], { showNotes: true });
	assert.equal(result.text, "compare [pasted image: 101x51 PNG, 37 B] with [pasted image: 102x52 PNG, 37 B] please");
	assert.equal(result.used.length, 2);
	assert.deepEqual(result.dropped, []);
	assert.equal(result.images.length, 2);
	assert.equal(result.images[0].type, "image");
	assert.equal(result.images[0].mimeType, "image/png");
	assert.equal(result.images[0].data, Buffer.from(image(1).bytes).toString("base64"));
});

test("every copy of a token is replaced and only one image is attached", () => {
	const result = applyAttachments("[image 1] and again [image 1]", [image(1)], { showNotes: false });
	assert.equal(result.text, "and again");
	assert.equal(result.images.length, 1);
});

test("with notes off the tokens disappear and the images still go", () => {
	const result = applyAttachments("look [image 1]", [image(1)], { showNotes: false });
	assert.equal(result.text, "look");
	assert.equal(result.images.length, 1);
});

test("an image the user deleted from the text is not sent", () => {
	const result = applyAttachments("only the first [image 1]", [image(1), image(2)], { showNotes: true });
	assert.equal(result.text, "only the first [pasted image: 101x51 PNG, 37 B]");
	assert.equal(result.images.length, 1);
	assert.deepEqual(result.dropped, [2]);
});

test("a cleared editor still sends every pending image, with its notes", () => {
	const result = applyAttachments("what is this?", [image(1), image(2)], { showNotes: true });
	assert.equal(result.text, "what is this?\n[pasted image: 101x51 PNG, 37 B] [pasted image: 102x52 PNG, 37 B]");
	assert.equal(result.images.length, 2);
});

test("with notes off a cleared editor sends the images silently", () => {
	const result = applyAttachments("what is this?", [image(1), image(2)], { showNotes: false });
	assert.equal(result.text, "what is this?");
	assert.equal(result.images.length, 2);
});

test("a message that is only tokens still has text", () => {
	const result = applyAttachments("[image 1]", [image(1)], { showNotes: false });
	assert.equal(result.text, "(1 image attached)");
	assert.equal(result.images.length, 1);
});

test("the empty-text fallback counts the images and can be replaced", () => {
	const result = applyAttachments("  [image 1] [image 2]  ", [image(1), image(2)], {
		showNotes: false,
		emptyText: (count) => `see ${count} screenshots`,
	});
	assert.equal(result.text, "see 2 screenshots");
});

test("no pending images leaves the text alone", () => {
	const result = applyAttachments("just text", [], { showNotes: true });
	assert.equal(result.text, "just text");
	assert.deepEqual(result.images, []);
	assert.deepEqual(result.used, []);
});

test("different formats keep their own mime type", () => {
	const result = applyAttachments("[image 1] [image 2]", [image(1), image(2, { mimeType: "image/gif", bytes: gifBytes(), name: "loop.gif" })], {
		showNotes: true,
	});
	assert.deepEqual(
		result.images.map((entry) => entry.mimeType),
		["image/png", "image/gif"],
	);
	assert.match(result.text, /loop\.gif/);
});

test("stripPlaceholders removes tokens without touching the rest", () => {
	assert.equal(stripPlaceholders("a [image 1] b [image 2] c", [image(1), image(2)]), "a  b  c");
	assert.equal(stripPlaceholders("nothing here", [image(1)]), "nothing here");
});

test("unreferencedImages finds the images whose token left the editor", () => {
	const pending = [image(1), image(2), image(3)];
	assert.deepEqual(
		unreferencedImages("look [image 1] and [image 3]", pending).map((entry) => entry.index),
		[2],
	);
	// A token the user is halfway through typing still counts as removed, because
	// the pending list follows the tokens that are actually there.
	assert.deepEqual(
		unreferencedImages("[image 1] [image ]", pending).map((entry) => entry.index),
		[2, 3],
	);
	assert.deepEqual(
		unreferencedImages("", pending).map((entry) => entry.index),
		[1, 2, 3],
	);
	assert.deepEqual(unreferencedImages("[image 1] [image 2] [image 3]", pending), []);
	assert.deepEqual(unreferencedImages("[image 1]", []), []);
});
