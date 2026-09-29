/** Minimal byte fixtures for the image tests — headers only, no real encoders. */

function u32be(value) {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u16be(value) {
	return [(value >>> 8) & 0xff, value & 0xff];
}

function u16le(value) {
	return [value & 0xff, (value >>> 8) & 0xff];
}

function u24le(value) {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

function ascii(text) {
	return [...text].map((char) => char.charCodeAt(0));
}

export function pngBytes(width = 1440, height = 900) {
	return Uint8Array.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
		...u32be(13), ...ascii("IHDR"),
		...u32be(width), ...u32be(height),
		8, 6, 0, 0, 0, // bit depth, colour type, compression, filter, interlace
		...u32be(0), // CRC placeholder
		0, 1, 2, 3, // trailing pixel-ish bytes so the payload is not empty
	]);
}

export function gifBytes(width = 800, height = 600) {
	return Uint8Array.from([
		...ascii("GIF89a"),
		...u16le(width), ...u16le(height),
		0xf7, 0x00, 0x00,
		0x3b,
	]);
}

export function jpegBytes(width = 1280, height = 720) {
	return Uint8Array.from([
		0xff, 0xd8, // SOI
		0xff, 0xe0, ...u16be(16), ...ascii("JFIF\0"), 1, 2, 0, 0, 1, 0, 1, 0, 0, // APP0
		0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, // SOF0
		0xff, 0xd9, // EOI
	]);
}

export function webpBytes(width = 640, height = 480) {
	return Uint8Array.from([
		...ascii("RIFF"), ...u32be(30), ...ascii("WEBP"),
		...ascii("VP8X"), ...u32be(10), 0x10, 0, 0, 0,
		...u24le(width - 1), ...u24le(height - 1),
		0, 0, 0,
	]);
}

export function webpLossyBytes(width = 320, height = 240) {
	return Uint8Array.from([
		...ascii("RIFF"), ...u32be(30), ...ascii("WEBP"),
		...ascii("VP8 "), ...u32be(18), 0, 0, 0,
		0x9d, 0x01, 0x2a,
		...u16le(width), ...u16le(height),
		0, 0, 0,
	]);
}

export function webpLosslessBytes(width = 100, height = 50) {
	// VP8L bitstream: signature 0x2f, then 14 bits width-1 and 14 bits height-1.
	const bits = (width - 1) | ((height - 1) << 14);
	return Uint8Array.from([
		...ascii("RIFF"), ...u32be(30), ...ascii("WEBP"),
		...ascii("VP8L"), ...u32be(10), 0x2f,
		bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff,
		0, 0, 0, 0,
	]);
}

export function binaryPayload(length = 64, fill = 0x00) {
	return Uint8Array.from({ length }, () => fill);
}
