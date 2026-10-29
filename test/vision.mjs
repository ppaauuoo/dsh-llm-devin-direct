/**
 * Vision check: a real image goes through the adapter's attachment path and the
 * model reports what it sees. This is the only test that proves `modalities()`
 * including "image" is honest — the wire format supported field 10 long before
 * the adapter ever sent one.
 *
 * Part 1 builds a solid-red PNG on disk and points a stub attachment store at it,
 * so `collectImages` exercises the same `imageHostPath` -> readFile -> base64
 * route it takes in the harness.
 * Part 2 also covers the tool-role case: an image arriving as a tool result
 * (`read_image`) must reach the model, not be flattened to text.
 *
 *   node test/vision.mjs [modelUid]
 */
import { deflateSync } from "node:zlib";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const model = process.argv[2] ?? "gpt-6-1-sol-high";

// --- minimal PNG writer: a solid RGB square, no dependencies ---
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(buf) {
	let c = 0xffffffff;
	for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}
function solidPng(size, [r, g, b]) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // truecolour
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
	const raw = Buffer.concat(Array.from({ length: size }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0))
	]);
}

const dir = await mkdtemp(join(tmpdir(), "devin-vision-"));
const pngPath = join(dir, "red.png");
const png = solidPng(64, [220, 20, 20]);
await writeFile(pngPath, png);

// --- drive the real adapter with a stub attachment store ---
const mod = await import("@vorkna/dsh-llm-devin-direct");
const store = {
	imageHostPath: (attachment) => (attachment?.path === pngPath ? pngPath : undefined)
};
let adapter;
const ctx = {
	effect: (fn) => fn(),
	get: (key) => (key === "attachments" ? store : undefined),
	llm: {
		registerAdapter: (_ids, a) => {
			adapter = a;
		},
		registerConfigurableProviders: () => {}
	}
};
mod.apply(ctx, new mod.Config({}));
if (!adapter) throw new Error("adapter was not registered");

const { model: resolved, stream } = await adapter.prepareCall("devin-direct", model);
console.log(`model      ${model}`);
console.log(`modalities ${resolved.inputModalities.join("+")}`);
console.log(`image      ${png.byteLength} bytes at ${pngPath}`);
console.log("---");

if (!resolved.inputModalities.includes("image")) {
	console.log("RESULT: FAIL — model is not advertised as image-capable");
	await rm(dir, { recursive: true, force: true });
	process.exit(1);
}

const attachment = { path: pngPath, bytes: png.byteLength, mediaType: "image/png", name: "red.png" };
const cases = [
	{
		name: "user message",
		messages: [
			{
				role: "user",
				id: "m1",
				content: [
					{ type: "text", text: "What is the dominant colour of the attached image? One word." },
					{ type: "image", attachment }
				]
			}
		]
	},
	{
		name: "tool result",
		messages: [
			{ role: "user", id: "m1", content: [{ type: "text", text: "Read the image, then name its colour." }] },
			{
				role: "assistant",
				id: "m2",
				content: [
					{ type: "tool-call", id: "call_1", name: "read_image", arguments: { path: pngPath } }
				]
			},
			{
				role: "tool",
				id: "m3",
				toolCallId: "call_1",
				content: [{ type: "text", text: "image attached" }, { type: "image", attachment }]
			}
		]
	}
];

let failures = 0;
for (const testCase of cases) {
	let text = "";
	let finish = null;
	try {
		for await (const chunk of stream({ provider: "devin-direct", model, messages: testCase.messages })) {
			if (chunk.type === "text-delta") text += chunk.text;
			else if (chunk.type === "finish") finish = chunk.reason;
		}
	} catch (err) {
		console.log(`${testCase.name}: ERROR ${err.message}`);
		failures += 1;
		continue;
	}
	const sawRed = /\bred\b/i.test(text);
	if (finish?.kind === "error") {
		console.log(`${testCase.name}: finish error ${finish.failure.message}`);
		failures += 1;
	} else if (!sawRed) {
		console.log(`${testCase.name}: FAIL — model did not see red, said: ${text.slice(0, 160)}`);
		failures += 1;
	} else {
		console.log(`${testCase.name}: PASS — ${text.trim().slice(0, 60)}`);
	}
}

await rm(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nRESULT: PASS — images reach the model" : "\nRESULT: FAIL");
process.exit(failures === 0 ? 0 : 1);
