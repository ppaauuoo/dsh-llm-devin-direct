/**
 * Standalone round-trip check: auth -> GetChatMessage -> tool-call decode.
 * Proves the protocol works before anything is wired into dsh.
 *
 *   node test/roundtrip.mjs [modelUid]
 */
import { readCredentials, credentialsPath, resolveClientVersion, streamChatEvents } from "../lib/protocol.js";

const modelUid = process.argv[2] ?? "deepseek-v4-1-flash-1017-high";
const creds = readCredentials(credentialsPath());
if (!creds) {
	console.error(`no credentials at ${credentialsPath()}`);
	process.exit(1);
}

const tool = {
	name: "get_time",
	description: "Return the current time in an IANA timezone.",
	parameters: {
		type: "object",
		properties: { timezone: { type: "string", description: "IANA zone, e.g. Asia/Bangkok" } },
		required: ["timezone"]
	}
};

console.log(`model   ${modelUid}`);
console.log(`host    ${creds.apiServerUrl}`);
console.log(`client  ${resolveClientVersion("")} / devin-desktop`);
console.log("---");

const started = Date.now();
let text = "";
let reasoning = "";
const toolCalls = new Map();
let usage = null;
let finish = null;

try {
	for await (const event of streamChatEvents({
		apiKey: creds.apiKey,
		host: creds.apiServerUrl,
		ide: "devin-desktop",
		version: resolveClientVersion(""),
		modelUid,
		systemPrompt: "You are a terse assistant. Always use the provided tools when asked.",
		messages: [{ role: "user", content: "What time is it in Asia/Bangkok? Use the get_time tool." }],
		tools: [tool],
		maxOutputTokens: 2048
	})) {
		if (event.kind === "text") text += event.text;
		else if (event.kind === "reasoning") reasoning += event.text;
		else if (event.kind === "tool_call_start") {
			toolCalls.set(event.id, { name: event.name, args: "" });
			console.log(`tool_call_start  ${event.name}  id=${event.id}`);
		} else if (event.kind === "tool_call_args") {
			const call = [...toolCalls.values()].at(-1);
			if (call) call.args += event.argsDelta;
		} else if (event.kind === "usage") usage = event;
		else if (event.kind === "finish") finish = event.reason;
	}
} catch (err) {
	console.error("FAILED:", err.message);
	process.exit(1);
}

const ms = Date.now() - started;
console.log("---");
if (text) console.log(`text (${text.length} ch): ${text.slice(0, 300)}`);
if (reasoning) console.log(`reasoning: ${reasoning.length} ch`);
for (const [id, call] of toolCalls) {
	console.log(`tool call: ${call.name}(${call.args})`);
}
console.log(`usage: in=${usage?.promptTokens ?? "?"} out=${usage?.completionTokens ?? "?"} cached=${usage?.cachedInputTokens ?? "-"}`);
console.log(`finish: ${finish}  ${ms}ms`);

const ok = toolCalls.size > 0 && [...toolCalls.values()].some((c) => c.name === "get_time" && c.args.includes("timezone"));
console.log(ok ? "\nRESULT: PASS — model emitted a harness-defined tool call" : "\nRESULT: FAIL — no usable tool call");
process.exit(ok ? 0 : 1);
