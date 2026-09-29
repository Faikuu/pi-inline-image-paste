/**
 * pi-inline-image-paste
 *
 * Pasted images become real image content on the next message instead of a
 * temporary file path in the text. Three capture paths feed one pending list:
 *
 *   1. the paste keybinding, which reads the system clipboard (the usual case)
 *   2. a terminal that streams image bytes into a bracketed paste, captured on
 *      raw stdin because pi decodes stdin as UTF-8 and would destroy them
 *   3. a paste that is really a dropped image file path, or /image-attach
 *
 * Pending images appear as thumbnails above the editor and as `[image N]`
 * tokens in the text, so you can see, move, or delete them before sending. The
 * `input` event swaps each token for the image it stands for.
 */

import { basename, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { getKeybindings, getNativeClipboard, matchesKey } from "@earendil-works/pi-tui";
import { applyAttachments, attachmentSummary, describeImage, placeholderToken, stripPlaceholders, unreferencedImages, type ImageContent, type PendingImage } from "./lib/attachments.ts";
import { AttachmentBar, attachmentWidgetLines } from "./lib/attachment-bar.ts";
import { readClipboardImage, readClipboardText } from "./lib/clipboard.ts";
import { configPatch, DEFAULT_CONFIG, parseConfig, type ImagePasteConfig } from "./lib/config.ts";
import { detectImageMimeType, imageDimensions, isSupportedImageMimeType } from "./lib/images.ts";
import { defaultPasteChordKeys, extractImagePaths, isPasteChord, splitPasteSequence } from "./lib/paste.ts";
import { interceptRawStdin, type RawStdinInterceptor, type RawStream } from "./lib/raw-stdin.ts";
import { globalSettingsPath, readSettings, writeSettings } from "./lib/settings.ts";

const WIDGET_KEY = "inline-image-paste";
const PASTE_KEYBINDING = "app.clipboard.pasteImage";

/** Matches a raw key sequence against a key id, tolerating unknown ids. */
const keyMatches = (data: string, key: string): boolean => {
	try {
		return matchesKey(data, key as never);
	} catch {
		return false;
	}
};

export default function inlineImagePaste(pi: ExtensionAPI) {
	let config: ImagePasteConfig = { ...DEFAULT_CONFIG };
	let pending: PendingImage[] = [];
	let nextIndex = 1;
	let ctx: ExtensionContext | undefined;
	let unsubscribeTerminal: (() => void) | undefined;
	let interceptor: RawStdinInterceptor | undefined;
	let pasting = false;
	let reconcileQueued = false;

	function notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		ctx?.ui.notify(message, type);
	}

	/**
	 * Resolve the keys bound to the paste-image action, honouring user
	 * rebindings, and fall back to pi's per-platform default.
	 */
	function pasteChordKeys(): string[] {
		try {
			const manager = getKeybindings() as unknown as { getKeys?: (id: string) => string[] };
			const keys = manager.getKeys?.(PASTE_KEYBINDING) ?? [];
			if (keys.length > 0) return keys;
		} catch {
			// A separate pi-tui instance carries no app-level bindings.
		}
		return defaultPasteChordKeys();
	}

	function refreshWidget(): void {
		if (!ctx) return;
		if (pending.length === 0 || !config.showPreview) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		if (ctx.mode !== "tui") {
			ctx.ui.setWidget(WIDGET_KEY, attachmentWidgetLines(pending, ctx.ui.theme));
			return;
		}
		const images = pending;
		const theme = ctx.ui.theme;
		const maxThumbnails = config.maxThumbnails;
		ctx.ui.setWidget(WIDGET_KEY, () => new AttachmentBar({ images, theme, maxThumbnails }));
	}

	function clearPending(): void {
		pending = [];
		nextIndex = 1;
		refreshWidget();
	}

	/** Queue an image and put its placeholder where the user is typing. */
	function attach(bytes: Uint8Array, declaredMimeType?: string, name?: string): void {
		if (!ctx) return;
		// The bytes decide; a declared type is only used when they are inconclusive.
		const mimeType = detectImageMimeType(bytes) ?? (isSupportedImageMimeType(declaredMimeType) ? declaredMimeType! : null);
		if (!mimeType) {
			notify("That does not look like a PNG, JPEG, GIF, or WebP image.", "warning");
			return;
		}
		if (pending.length >= config.maxImages) {
			notify(`Image limit reached (${config.maxImages}). Send the message, or raise "maxImages" in settings.`, "warning");
			return;
		}
		const total = pending.reduce((sum, image) => sum + image.bytes.length, 0) + bytes.length;
		if (total > config.maxTotalBytes) {
			notify(`Attachments exceed ${Math.round(config.maxTotalBytes / (1024 * 1024))} MB. Send the message first.`, "warning");
			return;
		}
		const image: PendingImage = {
			index: nextIndex++,
			bytes,
			mimeType,
			dimensions: imageDimensions(bytes, mimeType) ?? undefined,
			name,
		};
		pending = [...pending, image];
		// The token keeps the message non-empty and lets a single image be
		// dropped from the message without losing the rest.
		ctx.ui.pasteToEditor(`${placeholderToken(image)} `);
		refreshWidget();
	}

	/** Attach every path that is a readable image; return the ones that were not. */
	async function attachPaths(paths: string[]): Promise<string[]> {
		const failed: string[] = [];
		for (const path of paths) {
			const absolute = resolve(ctx?.cwd ?? process.cwd(), path);
			try {
				const stats = await stat(absolute);
				if (!stats.isFile() || stats.size === 0) {
					failed.push(path);
					continue;
				}
				const bytes = new Uint8Array(await readFile(absolute));
				if (!detectImageMimeType(bytes)) {
					failed.push(path);
					continue;
				}
				attach(bytes, undefined, basename(absolute));
			} catch {
				failed.push(path);
			}
		}
		return failed;
	}

	async function attachFromPaths(paths: string[]): Promise<string[]> {
		if (paths.length === 0) return [];
		const failed = await attachPaths(paths);
		if (failed.length > 0) notify(`Not a readable image: ${failed.join(", ")}`, "warning");
		return failed;
	}

	async function attachFromClipboard(): Promise<void> {
		if (!ctx || pasting) return;
		pasting = true;
		try {
			const image = await readClipboardImage({ nativeClipboard: () => getNativeClipboard() });
			if (image) {
				attach(image.bytes, image.mimeType);
				return;
			}
			// Nothing on the clipboard but text: paste it, as pi itself would —
			// unless the text is a path to an image, which is what screenshot and
			// file-manager apps copy. Those attach rather than land as text.
			const text = await readClipboardText({ nativeClipboard: () => getNativeClipboard() });
			if (!text) return;
			const paths = extractImagePaths(text);
			if (paths.length === 0) {
				ctx.ui.pasteToEditor(text);
				return;
			}
			const failed = await attachFromPaths(paths);
			if (failed.length === paths.length) ctx.ui.pasteToEditor(text);
		} catch (error) {
			notify(`Clipboard read failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			pasting = false;
		}
	}

	/**
	 * Keep the pending list in step with the editor text.
	 *
	 * The token is the user's only handle on an attachment, so a token they
	 * deleted is an image they do not want, and its thumbnail goes with it.
	 */
	function reconcileWithEditor(): void {
		if (!ctx || pending.length === 0) return;
		const dropped = unreferencedImages(ctx.ui.getEditorText(), pending);
		if (dropped.length === 0) return;
		pending = pending.filter((image) => !dropped.includes(image));
		refreshWidget();
		const labels = dropped.map((image) => image.name ?? `image #${image.index}`);
		notify(`Removed ${labels.join(", ")}: its [image N] token left the message.`, "info");
	}

	/**
	 * The editor has not processed the keystroke yet when the terminal handler
	 * runs, so the check waits a turn, by which time the text reflects the edit.
	 */
	function scheduleReconcile(): void {
		if (reconcileQueued || !ctx || ctx.mode !== "tui") return;
		reconcileQueued = true;
		setTimeout(() => {
			reconcileQueued = false;
			reconcileWithEditor();
		}, 0);
	}

	function handleTerminalInput(data: string): { consume?: boolean } | undefined {
		if (!ctx || ctx.mode !== "tui") return undefined;

		// Take the paste keybinding over so an image never becomes a file path.
		if (isPasteChord(data, pasteChordKeys(), keyMatches)) {
			void attachFromClipboard();
			return { consume: true };
		}

		// A dropped or pasted image path: stand the image in for the path.
		const sequence = splitPasteSequence(data);
		if (!sequence || sequence.before !== "" || sequence.after !== "") {
			scheduleReconcile();
			return undefined;
		}
		const paths = extractImagePaths(sequence.payload);
		if (paths.length === 0) {
			scheduleReconcile();
			return undefined;
		}
		void attachFromPaths(paths).then((failed) => {
			// Not images after all, so put the text back exactly as it arrived.
			if (failed.length === paths.length) ctx?.ui.pasteToEditor(sequence.payload);
		});
		return { consume: true };
	}

	function startRawCapture(): void {
		// Only meaningful in the TUI: other modes read stdin for their own protocol
		// and there is no terminal paste to intercept.
		if (!ctx || ctx.mode !== "tui" || interceptor) return;
		try {
			interceptor = interceptRawStdin(process.stdin as unknown as RawStream, {
				onImage: (bytes, mimeType) => attach(bytes, mimeType),
				onOverflow: (bytes) => notify(`Ignored a ${Math.round(bytes / (1024 * 1024))} MB paste: too large to attach.`, "warning"),
			});
		} catch (error) {
			interceptor = undefined;
			notify(`Could not watch raw terminal input: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	pi.on("session_start", async (_event, sessionCtx) => {
		ctx = sessionCtx;
		pending = [];
		nextIndex = 1;
		pasting = false;
		config = parseConfig(await readSettings(globalSettingsPath()));
		unsubscribeTerminal = ctx.ui.onTerminalInput(handleTerminalInput);
		startRawCapture();
		refreshWidget();
	});

	pi.on("session_shutdown", () => {
		// Idempotent: reload, session replacement, and exit all land here.
		interceptor?.restore();
		interceptor = undefined;
		unsubscribeTerminal?.();
		unsubscribeTerminal = undefined;
		ctx?.ui.setWidget(WIDGET_KEY, undefined);
		pending = [];
		nextIndex = 1;
		ctx = undefined;
	});

	pi.on("input", (event: InputEvent): InputEventResult | undefined => {
		if (pending.length === 0 || event.source !== "interactive") return undefined;
		const result = applyAttachments(event.text, pending, { showNotes: config.showNotes });
		clearPending();
		if (result.dropped.length > 0) {
			const noun = result.dropped.length > 1 ? "s" : "";
			notify(`Skipped image${noun} ${result.dropped.map((index) => `#${index}`).join(", ")}: removed from the message.`, "info");
		}
		const images: ImageContent[] = result.images;
		return { action: "transform", text: result.text, images };
	});

	pi.registerCommand("image-attach", {
		description: "Attach image files to the next message",
		handler: async (args, commandCtx) => {
			ctx = commandCtx;
			const paths = args
				.trim()
				.split(/\s+/)
				.map((path) => path.replace(/^["']|["']$/g, ""))
				.filter((path) => path !== "");
			if (paths.length === 0) {
				commandCtx.ui.notify("Usage: /image-attach <path> [path...]", "warning");
				return;
			}
			await attachFromPaths(paths);
		},
	});

	pi.registerCommand("image-list", {
		description: "List the images waiting to be sent",
		handler: async (_args, commandCtx) => {
			if (pending.length === 0) {
				commandCtx.ui.notify("No images attached. Paste one, drop a file, or run /image-attach <path>.", "info");
				return;
			}
			const rows = pending.map((image) => `  ${placeholderToken(image)}  ${describeImage(image)}`);
			commandCtx.ui.notify(`${attachmentSummary(pending)}\n${rows.join("\n")}`, "info");
		},
	});

	pi.registerCommand("image-clear", {
		description: "Remove all images waiting to be sent",
		handler: async (_args, commandCtx) => {
			if (pending.length === 0) {
				commandCtx.ui.notify("No images attached.", "info");
				return;
			}
			// The tokens are ordinary text in the editor, so they go with the images.
			commandCtx.ui.setEditorText(stripPlaceholders(commandCtx.ui.getEditorText(), pending));
			clearPending();
			commandCtx.ui.notify("Cleared pending images.", "info");
		},
	});

	pi.registerCommand("image-notes", {
		description: "Toggle the [image N: ...] note added to sent messages",
		handler: async (_args, commandCtx) => {
			const showNotes = !config.showNotes;
			const previous = config;
			config = { ...config, showNotes };
			const file = globalSettingsPath();
			try {
				await withFileMutationQueue(file, async () => {
					await writeSettings(file, configPatch(config, { showNotes }));
				});
			} catch (error) {
				config = previous;
				commandCtx.ui.notify(`Could not save to ${file}: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			commandCtx.ui.notify(
				showNotes
					? "Sent messages will show a note for each image, so the transcript is not blank."
					: "Sent messages will carry the image with no note. pi does not render images in the transcript.",
				"info",
			);
		},
	});
}
