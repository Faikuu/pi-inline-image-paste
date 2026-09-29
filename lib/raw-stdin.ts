/**
 * Byte-level paste capture.
 *
 * pi decodes stdin as UTF-8 before anything else sees it, which destroys image
 * bytes, so a terminal that streams a real image into the paste would otherwise
 * deliver mangled text. This module sits directly on the stdin stream: it takes
 * over the existing `data` listeners, inspects raw bytes, and forwards
 * everything that is not an image paste to those listeners unchanged and in
 * their original order.
 *
 * Only image pastes are withheld, so typing and text pastes keep their exact
 * current behaviour and latency.
 *
 * pi never puts stdin into string mode, so chunks arrive as Buffers. A stream
 * that does deliver strings is still handled: it is re-encoded as latin1 for
 * sniffing and forwarded byte-identically otherwise.
 */

import { detectImageMimeType, type SupportedImageMimeType } from "./images.ts";

const START = Buffer.from("\x1b[200~", "latin1");
const END = Buffer.from("\x1b[201~", "latin1");
const EMPTY = Buffer.alloc(0);

/** Bytes needed to recognise every supported container (RIFF....WEBP is 12). */
const SNIFF_BYTES = 12;

/** Largest image paste to buffer, in bytes. */
const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024;

type DataListener = (chunk: Buffer | string) => void;

export interface RawStream {
	on(event: "data", listener: DataListener): unknown;
	removeListener(event: "data", listener: DataListener): unknown;
	listeners(event: "data"): DataListener[];
	rawListeners?(event: "data"): DataListener[];
}

export interface InterceptOptions {
	/** Called once per captured image paste. */
	onImage: (bytes: Uint8Array, mimeType: SupportedImageMimeType) => void;
	/** Called when a paste is too large to buffer. */
	onOverflow?: (bytes: number) => void;
	maxImageBytes?: number;
	/** Escape sequences, as latin1 bytes. */
	escape?: { start: Buffer; end: Buffer };
}

export interface RawStdinInterceptor {
	readonly active: boolean;
	/** Put the original listeners back, in their original order. */
	restore(): void;
	/** Bytes currently withheld from the downstream listeners. */
	readonly heldBytes: number;
}

/**
 * idle      nothing withheld
 * sniffing  the opening marker was seen, not enough bytes to recognise a format
 * capturing an image is being withheld until the closing marker
 * replaying the paste was handed back downstream mid-flight
 */
type Mode = "idle" | "sniffing" | "capturing" | "replaying";

/**
 * Take over the stdin `data` listeners of `stream`.
 *
 * Returns an inactive interceptor when there is nothing to take over, so the
 * caller can fall back to clipboard-only capture.
 */
export function interceptRawStdin(stream: RawStream, options: InterceptOptions): RawStdinInterceptor {
	const start = options.escape?.start ?? START;
	const end = options.escape?.end ?? END;
	const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
	const registered = [...(stream.rawListeners?.("data") ?? stream.listeners("data"))].filter(
		(listener) => typeof listener === "function" && listener !== ours,
	) as DataListener[];

	let mode: Mode = "idle";
	let held: Buffer = EMPTY;
	let restored = false;

	function forward(chunk: Buffer): void {
		for (const listener of registered) listener(chunk);
	}

	/** Hand withheld bytes back, re-emitting the opening marker we consumed. */
	function release(bytes: Buffer = held): void {
		held = EMPTY;
		if (bytes.length > 0) forward(Buffer.concat([start, bytes]));
	}

	function giveUp(): void {
		options.onOverflow?.(held.length);
		mode = "replaying";
		release();
	}

	/** Decide whether the withheld bytes are an image, then finish or release. */
	function resolve(): void {
		if (mode === "sniffing") {
			const complete = held.includes(end);
			if (held.length < SNIFF_BYTES && !complete) return;
			mode = detectImageMimeType(held.subarray(0, SNIFF_BYTES)) ? "capturing" : "replaying";
		}
		if (mode === "capturing") {
			const endIndex = held.indexOf(end);
			if (endIndex === -1) {
				if (held.length > maxImageBytes) giveUp();
				return;
			}
			const payload = held.subarray(0, endIndex);
			const trailing = held.subarray(endIndex + end.length);
			held = EMPTY;
			mode = "idle";
			const mimeType = detectImageMimeType(payload);
			if (mimeType) options.onImage(new Uint8Array(payload), mimeType);
			if (trailing.length > 0) forward(trailing);
			return;
		}
		// replaying: the whole paste, markers included, goes downstream.
		const endIndex = held.indexOf(end);
		if (endIndex === -1) {
			if (held.length > maxImageBytes) giveUp();
			return;
		}
		const released = held;
		const trailing = released.subarray(endIndex + end.length);
		held = EMPTY;
		mode = "idle";
		release(released);
		if (trailing.length > 0) forward(trailing);
	}

	/** Stream a chunk that belongs to a paste already handed downstream. */
	function forwardUntilEnd(chunk: Buffer): void {
		const endIndex = chunk.indexOf(end);
		if (endIndex === -1) {
			forward(chunk);
			return;
		}
		mode = "idle";
		forward(chunk.subarray(0, endIndex + end.length));
		const trailing = chunk.subarray(endIndex + end.length);
		if (trailing.length > 0) forward(trailing);
	}

	function ours(chunk: Buffer | string): void {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "latin1");

		if (mode === "replaying") {
			forwardUntilEnd(buffer);
			return;
		}
		if (mode === "idle") {
			// A marker that does not start the chunk means this chunk mixes input
			// types (a keystroke plus a paste); the downstream parser owns it.
			if (buffer.indexOf(start) !== 0) {
				forward(buffer);
				return;
			}
			held = buffer.subarray(start.length);
			mode = "sniffing";
			resolve();
			return;
		}
		held = held.length === 0 ? buffer : Buffer.concat([held, buffer]);
		resolve();
	}

	if (registered.length === 0) {
		return { active: false, heldBytes: 0, restore() {} };
	}

	for (const listener of registered) stream.removeListener("data", listener);
	stream.on("data", ours);

	return {
		active: true,
		get heldBytes() {
			return held.length;
		},
		restore() {
			if (restored) return;
			restored = true;
			stream.removeListener("data", ours);
			for (const listener of registered) stream.on("data", listener);
		},
	};
}
