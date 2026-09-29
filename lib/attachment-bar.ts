/**
 * Composer preview for pending images: a strip of thumbnails with a caption.
 *
 * Where the terminal speaks a graphics protocol, each slot is a real thumbnail
 * drawn by pi-tui's `Image`; everywhere else it is a compact `#1 1440x900 PNG`
 * label, so the widget is useful in any terminal.
 */

import { HStack, Image, Text, getCapabilities, getImageDimensions, truncateToWidth, visibleWidth, type Component, type StackChild } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { attachmentSummary, type PendingImage } from "./attachments.ts";
import { formatBytes, formatDimensions, mimeLabel, toBase64 } from "./images.ts";

/** Thumbnail size in cells. Small enough to keep the editor in view. */
const THUMB_WIDTH = 20;
const THUMB_HEIGHT = 8;

/**
 * Caps the width an `Image` is rendered at.
 *
 * pi-tui sizes a thumbnail to the full width it is handed whenever the terminal
 * has no graphics protocol, so the fallback label would otherwise stretch the
 * whole strip and squeeze everything else out.
 */
class Thumbnail implements Component {
	private readonly image: Image;
	private readonly maxWidth: number;

	constructor(image: Image, maxWidth: number) {
		this.image = image;
		this.maxWidth = maxWidth;
	}

	render(width: number): string[] {
		const capped = Math.max(8, Math.min(width, this.maxWidth));
		return this.image.render(capped).map((line) => truncateToWidth(line, capped));
	}

	invalidate(): void {
		this.image.invalidate();
	}
}

/** A `Text` child whose layout width is pinned, so padding cannot take over. */
function fixedWidth(text: string, width: number): StackChild {
	return { component: new Text(text, 0, 0), basis: Math.max(1, width), grow: 0, shrink: 0 };
}

/** Plain-string clipping, for text that carries no escape sequences. */
function clip(text: string, width: number): string {
	return visibleWidth(text) <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export interface AttachmentBarOptions {
	images: readonly PendingImage[];
	theme: Theme;
	/** How many thumbnails to draw before collapsing into a "+N" chip. */
	maxThumbnails?: number;
}

export class AttachmentBar implements Component {
	private images: readonly PendingImage[];
	private theme: Theme;
	private maxThumbnails: number;
	private built: string[] | undefined;
	private builtKey = "";

	constructor(options: AttachmentBarOptions) {
		this.images = options.images;
		this.theme = options.theme;
		this.maxThumbnails = Math.max(1, options.maxThumbnails ?? 4);
	}

	update(images: readonly PendingImage[]): void {
		this.images = images;
	}

	/** A stable key so a rebuild is skipped when nothing changed. */
	private key(width: number): string {
		return `${width}|${this.maxThumbnails}|${this.images.map((image) => `${image.index}:${image.bytes.length}:${image.mimeType}`).join(",")}`;
	}

	private build(width: number): string[] {
		const key = this.key(width);
		if (this.built && this.builtKey === key) return this.built;

		const shown = this.images.slice(0, this.maxThumbnails);
		const hidden = this.images.length - shown.length;
		const children: StackChild[] = shown.map((image) => this.thumbnail(image));
		if (hidden > 0) {
			children.push(fixedWidth(this.theme.fg("muted", `+${hidden} more`), `+${hidden} more`.length));
		}

		const strip = new HStack(children, { gap: 1 });
		// One leading space of padding, then clip by visible cells: slicing the
		// string would cut through the escape sequences a thumbnail contains.
		const inner = Math.max(1, width - 1);
		const stripLines = strip.render(inner).map((line) => truncateToWidth(` ${line}`, width));
		const caption = truncateToWidth(` ${this.theme.fg("dim", attachmentSummary(this.images))}`, width);
		this.built = [...stripLines, caption];
		this.builtKey = key;
		return this.built;
	}

	/**
	 * One slot in the strip: a real thumbnail where the terminal can draw one,
	 * a compact label where it cannot.
	 */
	private thumbnail(image: PendingImage): StackChild {
		const label = this.label(image);
		if (!getCapabilities().images) {
			// pi-tui's Text pads to whatever width it is handed, which would let a
			// label swallow the whole strip, so its size is pinned here.
			return fixedWidth(this.theme.fg("muted", label), visibleWidth(label));
		}
		const base64 = toBase64(image.bytes);
		const dimensions = getImageDimensions(base64, image.mimeType) ?? undefined;
		const component = new Image(
			base64,
			image.mimeType,
			{ fallbackColor: (text) => this.theme.fg("muted", text) },
			{ maxWidthCells: THUMB_WIDTH, maxHeightCells: THUMB_HEIGHT, filename: image.name ?? `image ${image.index}` },
			dimensions,
		);
		return new Thumbnail(component, THUMB_WIDTH);
	}

	private label(image: PendingImage): string {
		const size = formatDimensions(image.dimensions);
		const what = image.name ?? (size ? `${size} ${mimeLabel(image.mimeType)}` : mimeLabel(image.mimeType));
		return `#${image.index} ${clip(what, 16)}`;
	}

	render(width: number): string[] {
		if (this.images.length === 0) return [];
		return [...this.build(Math.max(1, width))];
	}

	invalidate(): void {
		this.built = undefined;
		this.builtKey = "";
	}
}

/** A text summary, for modes without a terminal widget. */
export function attachmentWidgetLines(images: readonly PendingImage[], theme: Theme): string[] {
	if (images.length === 0) return [];
	// pi caps widget text at ten lines, so the list is trimmed here instead.
	const shown = images.slice(0, 8);
	const hidden = images.length - shown.length;
	const lines = shown.map((image) =>
		theme.fg(
			"dim",
			`  ${image.name ?? `image ${image.index}`} — ${formatDimensions(image.dimensions) ?? "?"} ${mimeLabel(image.mimeType)}, ${formatBytes(image.bytes.length)}`,
		),
	);
	if (hidden > 0) lines.push(theme.fg("dim", `  … and ${hidden} more`));
	return [theme.fg("muted", attachmentSummary(images)), ...lines];
}
