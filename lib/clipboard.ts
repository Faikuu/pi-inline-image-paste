/**
 * Clipboard access.
 *
 * pi does not export its own clipboard reader, and the public pi-tui surface
 * only covers platforms that ship a native helper, so the command-line
 * backends are reimplemented here: the same tools pi itself drives, in the same
 * order of preference, with an injectable exec so the strategy is testable.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectImageMimeType, isSupportedImageMimeType, SUPPORTED_IMAGE_MIME_TYPES, type SupportedImageMimeType } from "./images.ts";

export interface ClipboardImage {
	bytes: Uint8Array;
	mimeType: SupportedImageMimeType;
}

/** Structural subset of pi-tui's NativeClipboard, so tests need no native module. */
export interface NativeClipboardLike {
	getText(): Promise<string | null | undefined>;
	getImage(): Promise<Uint8Array | null | undefined>;
}

/** Resolves to undefined when no native helper is available. */
export type NativeClipboardResolver = () => NativeClipboardLike | undefined;

/**
 * Runs a command and returns stdout. Returns undefined when the binary is
 * missing or the command failed, so callers can fall through to the next
 * backend. An empty buffer means the command succeeded with no output.
 */
export type ExecFn = (command: string, args: string[], timeoutMs: number) => Promise<Buffer | undefined>;

export interface ClipboardOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	exec?: ExecFn;
	nativeClipboard?: NativeClipboardResolver;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const POWERSHELL_TIMEOUT_MS = 5000;

/** Spawn-based exec used in production. */
export const runCommand: ExecFn = (command, args, timeoutMs) =>
	new Promise((resolve) => {
		let settled = false;
		const finish = (value: Buffer | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const child = execFile(command, args, { encoding: "buffer", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
			if (error) {
				// A non-zero exit usually means "the clipboard has no image", which is
				// different from "the tool is missing"; only report success buffers.
				finish((stdout as Buffer | undefined)?.length ? (stdout as Buffer) : undefined);
				return;
			}
			finish((stdout as Buffer) ?? Buffer.alloc(0));
		});
		const timer = setTimeout(() => {
			child.kill();
			finish(undefined);
		}, timeoutMs + 250);
	});

function baseMimeType(mimeType: string): string {
	return (mimeType.split(";")[0] ?? mimeType).trim().toLowerCase();
}

function pickPreferredImageType(types: string[]): string | null {
	const normalized = types.map((type) => baseMimeType(type)).filter(Boolean);
	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		if (normalized.includes(preferred)) return preferred;
	}
	return normalized.find((type) => type.startsWith("image/")) ?? null;
}

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

async function viaWlPaste(exec: ExecFn, timeoutMs: number): Promise<ClipboardImage | null | undefined> {
	const list = await exec("wl-paste", ["--list-types"], Math.min(timeoutMs, 1000));
	if (list === undefined) return undefined;
	const mimeType = pickPreferredImageType(list.toString("utf-8").split(/\r?\n/));
	if (!mimeType) return null;
	const data = await exec("wl-paste", ["--type", mimeType, "--no-newline"], timeoutMs);
	if (data === undefined) return undefined;
	if (data.length === 0) return null;
	// The advertised type is a hint; the bytes decide.
	const detected = detectImageMimeType(data);
	if (!detected) return null;
	return { bytes: new Uint8Array(data), mimeType: detected };
}

async function viaXclip(exec: ExecFn, timeoutMs: number): Promise<ClipboardImage | null | undefined> {
	const targets = await exec("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], Math.min(timeoutMs, 1000));
	let preferred: string | null = null;
	if (targets !== undefined) {
		preferred = pickPreferredImageType(targets.toString("utf-8").split(/\r?\n/));
		if (!preferred) return null;
	}
	for (const mimeType of preferred ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES] : SUPPORTED_IMAGE_MIME_TYPES) {
		const data = await exec("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"], timeoutMs);
		if (data !== undefined && data.length > 0) {
			// A clipboard can advertise a type it cannot actually deliver, so the
			// bytes get the final say.
			const detected = detectImageMimeType(data);
			if (detected) return { bytes: new Uint8Array(data), mimeType: detected };
		}
	}
	return undefined;
}

async function viaOsascript(exec: ExecFn, timeoutMs: number): Promise<ClipboardImage | null | undefined> {
	// «class PNGf» makes macOS transcode whatever is on the clipboard to PNG.
	const png = await exec("osascript", ["-e", "get the clipboard as «class PNGf»"], timeoutMs);
	if (png === undefined) return undefined;
	if (png.length > 0 && detectImageMimeType(png) === "image/png") return { bytes: new Uint8Array(png), mimeType: "image/png" };
	const jpeg = await exec("osascript", ["-e", "get the clipboard as «class JPEGf»"], timeoutMs);
	if (jpeg !== undefined && jpeg.length > 0 && detectImageMimeType(jpeg) === "image/jpeg") {
		return { bytes: new Uint8Array(jpeg), mimeType: "image/jpeg" };
	}
	return png.length > 0 || jpeg !== undefined ? null : undefined;
}

async function viaPowerShell(exec: ExecFn, timeoutMs: number): Promise<ClipboardImage | null | undefined> {
	// Clipboard bitmaps cannot go through the PowerShell stdout encoding safely,
	// so the image is written to a temp file and read back.
	const dir = await mkdtemp(join(tmpdir(), "pi-image-paste-"));
	const file = join(dir, "clip.png");
	const winPath = file.replace(/\\/g, "\\\\");
	const script = [
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		`$img = [System.Windows.Forms.Clipboard]::GetImage()`,
		`if ($img) { $img.Save('${winPath}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }`,
	].join("; ");
	try {
		const result = await exec("powershell.exe", ["-NoProfile", "-Command", script], Math.max(timeoutMs, POWERSHELL_TIMEOUT_MS));
		if (result === undefined) return undefined;
		if (result.toString("utf-8").trim() !== "ok") return null;
		const bytes = await readFile(file);
		return bytes.length === 0 ? null : { bytes: new Uint8Array(bytes), mimeType: "image/png" };
	} catch {
		return null;
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Read an image from the system clipboard, or null when there is none.
 *
 * Backends are tried native helper first, then per platform. A backend that
 * fails outright (tool missing) falls through; a backend that reports an empty
 * clipboard ends the search, so a stale X11 selection cannot resurrect an old
 * screenshot after an empty Wayland clipboard.
 */
export async function readClipboardImage(options: ClipboardOptions = {}): Promise<ClipboardImage | null> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const exec = options.exec ?? runCommand;
	const nativeClipboard = options.nativeClipboard ?? (() => undefined);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (env.TERMUX_VERSION) return null;

	try {
		const native = nativeClipboard();
		if (native) {
			const bytes = await native.getImage();
			if (bytes === undefined) throw new Error("unavailable");
			if (bytes && bytes.length > 0) {
				const detected = detectImageMimeType(bytes);
				if (detected) return { bytes, mimeType: detected };
				// Unrecognised format (e.g. a DIB wrapped as BMP): nothing to do
				// without a transcoder, so keep looking at the command backends.
			}
		}
	} catch {
		// No usable native helper; fall through to the command-line backends.
	}

	let image: ClipboardImage | null | undefined;
	if (platform === "darwin") {
		image = await viaOsascript(exec, timeoutMs);
	} else if (platform === "win32") {
		image = await viaPowerShell(exec, timeoutMs);
	} else if (isWaylandSession(env)) {
		// An empty Wayland clipboard is authoritative: falling through to X11 here
		// would resurrect whatever selection was there before.
		const wayland = await viaWlPaste(exec, timeoutMs);
		image = wayland === undefined ? await viaXclip(exec, timeoutMs) : wayland;
	} else {
		image = await viaXclip(exec, timeoutMs);
	}

	if (!image) return null;
	const detected = detectImageMimeType(image.bytes);
	if (!detected || !isSupportedImageMimeType(detected)) return null;
	return { bytes: image.bytes, mimeType: detected };
}

/** Read plain text from the system clipboard. */
export async function readClipboardText(options: ClipboardOptions = {}): Promise<string | null> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const exec = options.exec ?? runCommand;
	const nativeClipboard = options.nativeClipboard ?? (() => undefined);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	try {
		const native = nativeClipboard();
		if (native) {
			const text = await native.getText();
			if (text !== undefined) return text;
		}
	} catch {
		// Fall through to the command-line backends.
	}

	const command =
		platform === "darwin"
			? { file: "pbpaste", args: [] as string[] }
			: platform === "win32"
				? { file: "powershell.exe", args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"] }
				: isWaylandSession(env)
					? { file: "wl-paste", args: ["--no-newline"] }
					: { file: "xclip", args: ["-selection", "clipboard", "-o"] };
	const result = await exec(command.file, command.args, timeoutMs);
	if (result === undefined || result.length === 0) return null;
	return result.toString("utf-8");
}
