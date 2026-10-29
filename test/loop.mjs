/**
 * Two-turn loop check: turn 1 asks for a tool call, turn 2 replays the
 * assistant tool-call plus the tool result and expects a text answer.
 * This is the exact shape dsh's agent loop will drive.
 *
 *   node test/loop.mjs [modelUid]
 */
const mod = await import("@vorkna/dsh-llm-devin-direct");

const model = process.argv[2] ?? "deepseek-v4-1-flash-1017-high";
let adapter;
mod.apply(
	{
		effect: (fn) => fn(),
		llm: {
			registerAdapter: (_ids, a) => {
				adapter = a;
			},
			registerConfigurableProviders: () => {}
		}
	},
	new mod.Config({})
);

const tools = [
	{
		name: "get_time",
		description: "Return the current time in an IANA timezone.",
		parameters: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"] }
	}
];

const run = async (messages) => {
	const { stream } = await adapter.prepareCall("devin-direct", model);
	let text = "";
	const calls = [];
	let current = null;
	for await (const chunk of stream({ provider: "devin-direct", model, messages, tools, system: "Be terse." })) {
		if (chunk.type === "text-delta") text += chunk.text;
		else if (chunk.type === "tool-call-delta") {
			if (current?.id !== chunk.id) {
				current = { id: chunk.id, name: chunk.name, args: "" };
				calls.push(current);
			}
			current.args += chunk.argumentsDelta;
		} else if (chunk.type === "finish" && chunk.reason.kind === "error") {
			throw new Error(chunk.reason.failure.message);
		}
	}
	return { text: text.trim(), calls };
};

const userMsg = {
	role: "user",
	id: "u1",
	content: [{ type: "text", text: "What time is it in Asia/Bangkok? Use get_time." }]
};

const turn1 = await run([userMsg]);
console.log(`turn1: ${turn1.calls.length} tool call(s), text=${JSON.stringify(turn1.text.slice(0, 80))}`);
if (turn1.calls.length === 0) {
	console.log("RESULT: FAIL — turn 1 produced no tool call");
	process.exit(1);
}
const call = turn1.calls[0];
console.log(`turn1 call: ${call.name}(${call.args})`);

const history = [
	userMsg,
	{
		role: "assistant",
		id: "a1",
		content: [{ type: "tool-call", id: call.id, name: call.name, arguments: call.args }]
	},
	{
		role: "tool",
		id: "t1",
		toolCallId: call.id,
		content: [{ type: "text", text: "2026-10-27 15:42 ICT (UTC+7)" }]
	}
];

const turn2 = await run(history);
console.log(`turn2: text=${JSON.stringify(turn2.text.slice(0, 160))}`);

const ok = turn2.text.length > 0 && /15:42|ICT|UTC\+7/.test(turn2.text);
console.log(ok ? "\nRESULT: PASS — model consumed the tool result and answered" : "\nRESULT: FAIL — no answer from tool result");
process.exit(ok ? 0 : 1);
