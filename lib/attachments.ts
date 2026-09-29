/**
 * Pending attachments: the placeholder tokens the user sees in the editor and
 * the transformation that turns them into real image content on submit.
 *
 * Pure functions only.
 */

import { formatBytes, formatDimensions, mimeLabel, toBase64, type ImageDimensions } from "./images.ts";

export interface PendingImage {
	/** 1-based display number, stable for the lifetime of the pending list. */
	index: number;
	bytes: Uint8Array;
	mimeType: string;
	dimensions?: ImageDimensions | undefined;
	/** Source file name when the image came from a path rather than the clipboard. */
	name?: string | undefined;
}

/** The subset of pi's `ImageContent` this extension produces. */
export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

/** Token inserted into the editor so the user can see, move, or delete the image. */
export function placeholderToken(image: PendingImage): string {
	return `[image ${image.index}]`;
}

/** The visible note the placeholder becomes in the sent message. */
export function attachmentNote(image: PendingImage): string {
	const parts: string[] = [];
	const size = formatDimensions(image.dimensions);
	const weight = formatBytes(image.bytes.length);
	if (size) parts.push(`${size} ${mimeLabel(image.mimeType)}`);
	else parts.push(mimeLabel(image.mimeType));
	if (weight) parts.push(weight);
	const label = image.name ?? "pasted image";
	return `[${label}: ${parts.join(", ")}]`;
}

/** One-line summary for the composer widget and `/image-list`. */
export function describeImage(image: PendingImage): string {
	const size = formatDimensions(image.dimensions);
	const where = image.name ?? `image ${image.index}`;
	return size ? `${where} — ${size} ${mimeLabel(image.mimeType)}, ${formatBytes(image.bytes.length)}` : `${where} — ${mimeLabel(image.mimeType)}, ${formatBytes(image.bytes.length)}`;
}

export interface ApplyOptions {
	/** Replace each token with a visible note. When false, tokens are removed. */
	showNotes: boolean;
	/** Text used when the message would otherwise be empty. */
	emptyText?: (count: number) => string;
}

export interface ApplyResult {
	text: string;
	images: ImageContent[];
	/** Placeholders that were referenced by the submitted text. */
	used: number[];
	/** Images that were pending but not referenced anywhere in the text. */
	dropped: number[];
}

const defaultEmptyText = (count: number) => (count === 1 ? "(1 image attached)" : `(${count} images attached)`);

/**
 * Fold pending images into a submitted message.
 *
 * A token that appears in the text is the user saying "send this one", so
 * images are matched on their tokens. If no token survives — a cleared editor,
 * or any source without one to watch — that is not read as a decision to drop
 * every screenshot, so all pending images are sent instead. In the TUI the
 * editor is watched as you type, so a deleted token is already gone by now and
 * this fallback only covers other input sources.
 */
export function applyAttachments(text: string, pending: readonly PendingImage[], options: ApplyOptions): ApplyResult {
	if (pending.length === 0) return { text, images: [], used: [], dropped: [] };

	const tokens = pending.map((image) => ({ image, token: placeholderToken(image), present: text.includes(placeholderToken(image)) }));
	const referenced = tokens.filter((entry) => entry.present);
	const chosen = referenced.length > 0 ? referenced : tokens;

	let out = text;
	for (const entry of chosen) {
		const replacement = options.showNotes ? attachmentNote(entry.image) : "";
		out = out.split(entry.token).join(replacement);
	}

	// Images whose token was not in the text cannot be placed; note them at the end
	// so the model and the transcript still show what came along.
	const unplaced = chosen.filter((entry) => !entry.present);
	if (options.showNotes && unplaced.length > 0) {
		const tail = unplaced.map((entry) => attachmentNote(entry.image)).join(" ");
		out = out.trim() === "" ? tail : `${out.replace(/\s+$/, "")}\n${tail}`;
	}

	const emptyText = options.emptyText ?? defaultEmptyText;
	if (out.trim() === "") out = emptyText(chosen.length);
	else out = out.replace(/[ \t]+$/, "").replace(/^[ \t]+/, "");

	const used = chosen.filter((entry) => entry.present).map((entry) => entry.image.index);
	const dropped = pending.filter((image) => !chosen.some((entry) => entry.image.index === image.index)).map((image) => image.index);

	return {
		text: out,
		images: chosen.map((entry) => ({ type: "image", data: toBase64(entry.image.bytes), mimeType: entry.image.mimeType })),
		used,
		dropped,
	};
}

/** Remove every placeholder token from a string, e.g. when clearing attachments. */
export function stripPlaceholders(text: string, pending: readonly PendingImage[]): string {
	let out = text;
	for (const image of pending) out = out.split(placeholderToken(image)).join("");
	return out;
}

/**
 * The pending images whose token is no longer in the editor text.
 *
 * The token is the only handle the user has on an attachment, so deleting it
 * means dropping the image rather than sending an image nobody can point at.
 */
export function unreferencedImages(text: string, pending: readonly PendingImage[]): PendingImage[] {
	return pending.filter((image) => !text.includes(placeholderToken(image)));
}

/** Message shown by the composer widget. */
export function attachmentSummary(pending: readonly PendingImage[]): string {
	if (pending.length === 0) return "";
	const total = pending.reduce((sum, image) => sum + image.bytes.length, 0);
	const noun = pending.length === 1 ? "image" : "images";
	return `${pending.length} ${noun} attached · ${formatBytes(total)} · /image-clear to remove`;
}
