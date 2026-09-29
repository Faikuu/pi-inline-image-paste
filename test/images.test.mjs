import { test } from "node:test";
import assert from "node:assert/strict";

import {
	detectImageMimeType,
	extensionForImageMimeType,
	formatBytes,
	formatDimensions,
	imageDimensions,
	isSupportedImageMimeType,
	looksLikeImagePath,
	mimeLabel,
	toBase64,
} from "../lib/images.ts";
import { binaryPayload, gifBytes, jpegBytes, pngBytes, webpBytes, webpLosslessBytes, webpLossyBytes } from "./fixtures.mjs";

test("detectImageMimeType recognizes every supported container", () => {
	assert.equal(detectImageMimeType(pngBytes()), "image/png");
	assert.equal(detectImageMimeType(jpegBytes()), "image/jpeg");
	assert.equal(detectImageMimeType(gifBytes()), "image/gif");
	assert.equal(detectImageMimeType(webpBytes()), "image/webp");
	assert.equal(detectImageMimeType(webpLossyBytes()), "image/webp");
	assert.equal(detectImageMimeType(webpLosslessBytes()), "image/webp");
});

test("detectImageMimeType rejects non-images and truncated headers", () => {
	assert.equal(detectImageMimeType(new Uint8Array(0)), null);
	assert.equal(detectImageMimeType(Uint8Array.from([0x89, 0x50, 0x4e])), null);
	assert.equal(detectImageMimeType(Uint8Array.from(Buffer.from("RIFF____WAVEfmt ", "ascii"))), null);
	assert.equal(detectImageMimeType(Buffer.from("%PDF-1.7\n")), null);
	assert.equal(detectImageMimeType(Buffer.from("plain text paste")), null);
});

test("imageDimensions parses png, jpeg, gif, and every webp variant", () => {
	assert.deepEqual(imageDimensions(pngBytes(1440, 900), "image/png"), { width: 1440, height: 900 });
	assert.deepEqual(imageDimensions(jpegBytes(1280, 720), "image/jpeg"), { width: 1280, height: 720 });
	assert.deepEqual(imageDimensions(gifBytes(800, 600), "image/gif"), { width: 800, height: 600 });
	assert.deepEqual(imageDimensions(webpBytes(640, 480), "image/webp"), { width: 640, height: 480 });
	assert.deepEqual(imageDimensions(webpLossyBytes(320, 240), "image/webp"), { width: 320, height: 240 });
	assert.deepEqual(imageDimensions(webpLosslessBytes(100, 50), "image/webp"), { width: 100, height: 50 });
});

test("imageDimensions tolerates truncated and unknown payloads", () => {
	assert.equal(imageDimensions(pngBytes().slice(0, 20), "image/png"), null);
	assert.equal(imageDimensions(jpegBytes().slice(0, 8), "image/jpeg"), null);
	assert.equal(imageDimensions(pngBytes(), "image/bmp"), null);
	assert.equal(imageDimensions(webpBytes().slice(0, 25), "image/webp"), null);
});

test("jpeg dimensions skip a scan-only stream without throwing", () => {
	// SOI immediately followed by SOS: no frame header, so no dimensions.
	const sos = Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]);
	assert.equal(imageDimensions(sos, "image/jpeg"), null);
});

test("mime helpers label and normalise", () => {
	assert.equal(mimeLabel("image/jpeg"), "JPEG");
	assert.equal(mimeLabel("image/png; charset=binary"), "PNG");
	assert.equal(extensionForImageMimeType("image/jpeg"), "jpg");
	assert.equal(extensionForImageMimeType("image/webp"), "webp");
	assert.equal(extensionForImageMimeType("image/tiff"), "png");
	assert.equal(isSupportedImageMimeType("image/gif"), true);
	assert.equal(isSupportedImageMimeType("image/bmp"), false);
	assert.equal(isSupportedImageMimeType(undefined), false);
});

test("formatBytes uses binary units", () => {
	assert.equal(formatBytes(0), "0 B");
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(1024), "1.0 KB");
	assert.equal(formatBytes(231 * 1024), "231 KB");
	assert.equal(formatBytes(1.5 * 1024 * 1024), "1.5 MB");
	assert.equal(formatBytes(-1), "?");
});

test("formatDimensions is undefined when unknown", () => {
	assert.equal(formatDimensions({ width: 10, height: 20 }), "10x20");
	assert.equal(formatDimensions(null), undefined);
	assert.equal(formatDimensions({ width: 0, height: 0 }), undefined);
});

test("looksLikeImagePath accepts the supported extensions only", () => {
	assert.equal(looksLikeImagePath("/tmp/shot.png"), true);
	assert.equal(looksLikeImagePath("/tmp/shot.JPEG"), true);
	assert.equal(looksLikeImagePath("/tmp/shot.webp"), true);
	assert.equal(looksLikeImagePath("/tmp/notes.txt"), false);
	assert.equal(looksLikeImagePath("https://example.com/a.png"), true);
});

test("toBase64 encodes without copying beyond the view", () => {
	const bytes = pngBytes();
	const view = bytes.subarray(4, 12);
	assert.equal(toBase64(view), Buffer.from(view).toString("base64"));
	assert.equal(toBase64(binaryPayload(0)), "");
});
