/**
 * Extension configuration, read from the global `settings.json` under the
 * `imagePaste` key. Every field is optional; the defaults suit normal use.
 */

export interface ImagePasteConfig {
	/** Maximum images queued for one message. */
	maxImages: number;
	/** Maximum total queued bytes for one message. */
	maxTotalBytes: number;
	/** Replace the `[image N]` token with a visible note in the sent message. */
	showNotes: boolean;
	/** Show the thumbnail strip above the editor. */
	showPreview: boolean;
	/** Thumbnails drawn at once in the strip. */
	maxThumbnails: number;
}

export const DEFAULT_CONFIG: ImagePasteConfig = {
	maxImages: 20,
	maxTotalBytes: 32 * 1024 * 1024,
	showNotes: true,
	showPreview: true,
	maxThumbnails: 4,
};

function positiveInt(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.floor(value);
}

function boolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** Parse the `imagePaste` block, ignoring anything of the wrong type. */
export function parseConfig(settings: Record<string, unknown>): ImagePasteConfig {
	const raw = settings.imagePaste;
	const block = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	return {
		maxImages: positiveInt(block.maxImages, DEFAULT_CONFIG.maxImages),
		maxTotalBytes: positiveInt(block.maxTotalMb === undefined ? block.maxTotalBytes : (block.maxTotalMb as number) * 1024 * 1024, DEFAULT_CONFIG.maxTotalBytes),
		showNotes: boolean(block.showNotes, DEFAULT_CONFIG.showNotes),
		showPreview: boolean(block.showPreview, DEFAULT_CONFIG.showPreview),
		maxThumbnails: positiveInt(block.maxThumbnails, DEFAULT_CONFIG.maxThumbnails),
	};
}

/** Serialize the user-facing subset back into a settings patch. */
export function configPatch(config: ImagePasteConfig, changes: Partial<ImagePasteConfig>): Record<string, unknown> {
	const next = { ...config, ...changes };
	return { imagePaste: { showNotes: next.showNotes, showPreview: next.showPreview } };
}
