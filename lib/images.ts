/**
 * Image sniffing, dimensions, and formatting.
 *
 * Pure functions only: no terminal, no filesystem, so they are cheap to test.
 * Magic-byte detection is used everywhere instead of trusting a file name or a
 * reported content type, because clipboard payloads lie about both.
 */

export const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

/** Extensions that mean "this path is probably an image", for drag-and-drop paths. */
export const IMAGE_PATH_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"] as const;

export interface ImageDimensions {
	width: number;
	height: number;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
	if (bytes.length < offset + signature.length) return false;
	for (let i = 0; i < signature.length; i++) {
		if (bytes[offset + i] !== signature[i]) return false;
	}
	return true;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	if (bytes.length < offset + length) return "";
	let out = "";
	for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
	return out;
}

function u16be(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] << 8) | bytes[offset + 1];
}

function u16le(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

/**
 * Identify an image payload from its leading bytes.
 * Returns null for anything that is not a PNG, JPEG, GIF, or WebP.
 */
export function detectImageMimeType(bytes: Uint8Array): SupportedImageMimeType | null {
	if (bytes.length === 0) return null;
	// PNG: \x89PNG\r\n\x1a\n
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	// GIF: GIF87a / GIF89a
	if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
	// RIFF....WEBP
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
	// JPEG: SOI then any APPn segment before the frame header.
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	return null;
}

/** True when the mime type is one pi can hand to a model. */
export function isSupportedImageMimeType(mimeType: string | undefined | null): boolean {
	if (!mimeType) return false;
	return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType.split(";")[0]!.trim().toLowerCase());
}

/** File extension for a mime type, without the dot. */
export function extensionForImageMimeType(mimeType: string): string {
	switch (mimeType.split(";")[0]!.trim().toLowerCase()) {
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return "png";
	}
}

/** Short uppercase label used in attachment notes, e.g. "PNG". */
export function mimeLabel(mimeType: string): string {
	switch (mimeType.split(";")[0]!.trim().toLowerCase()) {
		case "image/jpeg":
			return "JPEG";
		case "image/webp":
			return "WEBP";
		case "image/gif":
			return "GIF";
		case "image/png":
			return "PNG";
		default:
			return "IMAGE";
	}
}

/** "231 KB", "1.4 MB". Binary units, because that is what the bytes are. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "?";
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
	return `${(mb / 1024).toFixed(1)} GB`;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
	// IHDR is always the first chunk: 8 signature + 8 header = width at 16.
	if (bytes.length < 24) return null;
	const width = u32be(bytes, 16);
	const height = u32be(bytes, 20);
	return width > 0 && height > 0 ? { width, height } : null;
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | null {
	if (bytes.length < 10) return null;
	const width = u16le(bytes, 6);
	const height = u16le(bytes, 8);
	return width > 0 && height > 0 ? { width, height } : null;
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
	// Walk the marker segments to the frame header (SOF0..SOF15 minus the
	// non-frame markers C4, C8, and CC).
	let offset = 2;
	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = bytes[offset + 1]!;
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		const length = u16be(bytes, offset + 2);
		const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isFrame) {
			if (offset + 9 > bytes.length) return null;
			const height = u16be(bytes, offset + 5);
			const width = u16be(bytes, offset + 7);
			return width > 0 && height > 0 ? { width, height } : null;
		}
		if (marker === 0xda || length < 2) return null; // start of scan: no frame header found
		offset += 2 + length;
	}
	return null;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
	const chunk = ascii(bytes, 12, 4);
	if (chunk === "VP8X" && bytes.length >= 30) {
		const width = 1 + u24le(bytes, 24);
		const height = 1 + u24le(bytes, 27);
		return { width, height };
	}
	if (chunk === "VP8 " && bytes.length >= 30) {
		// Lossy: 3-byte frame tag, 3-byte sync code, then 14-bit dimensions.
		if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return null;
		return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
	}
	if (chunk === "VP8L" && bytes.length >= 25) {
		if (bytes[20] !== 0x2f) return null;
		const bits = u32leFallback(bytes, 21);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	return null;
}

function u32leFallback(bytes: Uint8Array, offset: number): number {
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

/**
 * Pixel dimensions of an encoded image, or null when they cannot be read.
 * Only the header is parsed; the payload is never decoded.
 */
export function imageDimensions(bytes: Uint8Array, mimeType: string): ImageDimensions | null {
	switch (mimeType.split(";")[0]!.trim().toLowerCase()) {
		case "image/png":
			return pngDimensions(bytes);
		case "image/jpeg":
			return jpegDimensions(bytes);
		case "image/gif":
			return gifDimensions(bytes);
		case "image/webp":
			return webpDimensions(bytes);
		default:
			return null;
	}
}

/** "1440x900" when known, otherwise undefined. */
export function formatDimensions(dimensions: ImageDimensions | null | undefined): string | undefined {
	if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return undefined;
	return `${dimensions.width}x${dimensions.height}`;
}

/** True when a path looks like it points at a supported image file. */
export function looksLikeImagePath(path: string): boolean {
	const lower = path.toLowerCase();
	return IMAGE_PATH_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Base64 for pi's `ImageContent`, which carries the payload as a string. */
export function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}
