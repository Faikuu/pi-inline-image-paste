import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { configPatch, DEFAULT_CONFIG, parseConfig } from "../lib/config.ts";
import { agentDir, globalSettingsPath, readSettings, writeSettings } from "../lib/settings.ts";

async function tmp() {
	return mkdtemp(join(tmpdir(), "piip-test-"));
}

test("parseConfig returns the defaults for an empty settings file", () => {
	assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
	assert.deepEqual(parseConfig({ imagePaste: undefined }), DEFAULT_CONFIG);
	assert.deepEqual(parseConfig({ imagePaste: "nonsense" }), DEFAULT_CONFIG);
	assert.deepEqual(parseConfig({ imagePaste: [1, 2] }), DEFAULT_CONFIG);
});

test("parseConfig reads each documented key", () => {
	const config = parseConfig({
		imagePaste: {
			maxImages: 3,
			maxTotalMb: 2,
			showNotes: false,
			showPreview: false,
			maxThumbnails: 2,
		},
	});
	assert.equal(config.maxImages, 3);
	assert.equal(config.maxTotalBytes, 2 * 1024 * 1024);
	assert.equal(config.showNotes, false);
	assert.equal(config.showPreview, false);
	assert.equal(config.maxThumbnails, 2);
});

test("parseConfig accepts maxTotalBytes as well as maxTotalMb", () => {
	assert.equal(parseConfig({ imagePaste: { maxTotalBytes: 4096 } }).maxTotalBytes, 4096);
	assert.equal(parseConfig({ imagePaste: { maxTotalMb: 1 } }).maxTotalBytes, 1024 * 1024);
});

test("parseConfig ignores values of the wrong type or range", () => {
	const config = parseConfig({
		imagePaste: { maxImages: 0, maxTotalMb: -5, showNotes: "yes", maxThumbnails: 1.7 },
	});
	assert.equal(config.maxImages, DEFAULT_CONFIG.maxImages);
	assert.equal(config.maxTotalBytes, DEFAULT_CONFIG.maxTotalBytes);
	assert.equal(config.showNotes, DEFAULT_CONFIG.showNotes);
	assert.equal(config.maxThumbnails, 1);
});

test("configPatch only writes the user-facing toggles", () => {
	const patch = configPatch(DEFAULT_CONFIG, { showNotes: false });
	assert.deepEqual(patch, { imagePaste: { showNotes: false, showPreview: true } });
});

test("agentDir honors PI_CODING_AGENT_DIR and expands ~", () => {
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "  /tmp/agent  " }), "/tmp/agent");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~", HOME: "/home/me" }), homedir());
	assert.equal(globalSettingsPath({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent/settings.json");
});

test("writeSettings merges and keeps unrelated keys", async () => {
	const dir = await tmp();
	const file = join(dir, "nested", "settings.json");
	await writeSettings(file, { defaultModel: "m1", imagePaste: { showNotes: true } });
	await writeSettings(file, { theme: "dark" });
	assert.deepEqual(await readSettings(file), {
		defaultModel: "m1",
		imagePaste: { showNotes: true },
		theme: "dark",
	});
	const text = await readFile(file, "utf8");
	assert.ok(text.endsWith("\n"));
	assert.ok(text.includes('  "theme": "dark"'));
});

test("readSettings tolerates missing and malformed files", async () => {
	const dir = await tmp();
	assert.deepEqual(await readSettings(join(dir, "missing.json")), {});
	const bad = join(dir, "bad.json");
	await writeFile(bad, "{not json");
	assert.deepEqual(await readSettings(bad), {});
	const array = join(dir, "array.json");
	await writeFile(array, "[1,2,3]");
	assert.deepEqual(await readSettings(array), {});
});
