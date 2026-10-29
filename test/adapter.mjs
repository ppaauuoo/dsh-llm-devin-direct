/**
 * Adapter-level check: drives the real dsh adapter with dsh-shaped GenerateOptions
 * and validates the StreamChunk sequence it emits (block-start / deltas /
 * block-end / usage / finish) without needing a harness restart.
 *
 *   node test/adapter.mjs [modelUid]
 */
const mod = await import("@vorkna/dsh-llm-devin-direct");

const model = process.argv[2] ?? "deepseek-v4-1-flash-1017-high";

let adapter;
const ctx = {
	effect: (fn) => fn(),
	llm: {
		registerAdapter: (_ids, a) => {
			adapter = a;
		},
		registerConfigurableProviders: () => {}
	}
};
mod.apply(ctx, new mod.Config({}));
if (!adapter) throw new Error("adapter was not registered");

const models = await adapter.listModels("devin-direct");
console.log(`models exposed: ${models.length} (${models.slice(0, 3).map((m) => m.id).join(", ")}...)`);

const { model: resolved, stream } = await adapter.prepareCall("devin-direct", model);
console.log(`resolved: ${resolved.provider}/${resolved.id} modalities=${resolved.inputModalities.join("+")}`);

const options = {
	provider: "devin-direct",
	model,
	system: "You are a terse assistant. Use the provided tools when asked.",
	messages: [
		{
			role: "user",
			id: "m1",
			content: [{ type: "text", text: "What time is it in Asia/Bangkok? Use get_time." }]
		}
	],
	tools: [
		{
			name: "get_time",
			description: "Return the current time in an IANA timezone.",
			parameters: {
				type: "object",
				properties: { timezone: { type: "string" } },
				required: ["timezone"]
			}
		}
	]
};

const started = Date.now();
const chunks = [];
for await (const chunk of stream(options)) chunks.push(chunk);

// --- validate the chunk protocol the harness assembler expects ---
const errors = [];
const open = new Map();
let finish = null;
let usage = null;
let text = "";
const toolArgs = new Map();

for (const chunk of chunks) {
	if (chunk.type === "block-start") {
		if (open.has(chunk.index)) errors.push(`duplicate block-start ${chunk.index}`);
		open.set(chunk.index, chunk.blockType);
	} else if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
		if (!open.has(chunk.index)) errors.push(`delta before block-start ${chunk.index}`);
		if (chunk.type === "text-delta") text += chunk.text;
	} else if (chunk.type === "tool-call-delta") {
		if (!open.has(chunk.index)) errors.push(`tool delta before block-start ${chunk.index}`);
		toolArgs.set(chunk.id, (toolArgs.get(chunk.id) ?? "") + chunk.argumentsDelta);
	} else if (chunk.type === "block-end") {
		const kind = open.get(chunk.index);
		if (kind === undefined) errors.push(`block-end without block-start ${chunk.index}`);
		else if (kind !== chunk.block.type) errors.push(`block-end type ${chunk.block.type} != ${kind}`);
		open.delete(chunk.index);
	} else if (chunk.type === "usage") {
		usage = chunk.usage;
	} else if (chunk.type === "finish") {
		finish = chunk.reason;
	}
}
if (open.size > 0) errors.push(`unclosed blocks: ${[...open.keys()].join(",")}`);
if (!finish) errors.push("no finish chunk");
if (finish && finish.kind === "error") errors.push(`finish error: ${finish.failure.message}`);

const calls = [...toolArgs.entries()].map(([id, args]) => ({ id, args }));
console.log(`chunks: ${chunks.length}  blocks: ${new Set(chunks.filter((c) => c.type === "block-start").map((c) => c.blockType)).size} kinds`);
if (text.trim()) console.log(`text: ${text.slice(0, 200)}`);
for (const call of calls) console.log(`tool call: ${call.args}`);
console.log(`usage: ${usage ? `in=${usage.inputTokens} out=${usage.outputTokens}` : "none reported"}`);
console.log(`finish: ${JSON.stringify(finish)}  ${Date.now() - started}ms`);

if (errors.length > 0) {
	console.log("\nPROTOCOL ERRORS:");
	for (const e of errors) console.log(` - ${e}`);
	console.log("RESULT: FAIL");
	process.exit(1);
}
const ok = finish?.kind === "tool-calls" && calls.some((c) => c.args.includes("timezone"));
console.log(ok ? "\nRESULT: PASS — well-formed chunks, finish=tool-calls" : "\nRESULT: FAIL — no tool call surfaced");
process.exit(ok ? 0 : 1);
