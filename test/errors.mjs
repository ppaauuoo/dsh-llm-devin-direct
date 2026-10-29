/**
 * Failure-path check: a bad key must surface as a clean error finish chunk,
 * not a hang or an unhandled rejection. This is what a coworker will hit first
 * if they are not signed in.
 *
 *   node test/errors.mjs
 */
const mod = await import("@vorkna/dsh-llm-devin-direct");

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
	new mod.Config({ apiKey: "definitely-not-a-valid-key" })
);

const { stream } = await adapter.prepareCall("devin-direct", "deepseek-v4-1-flash-1017-high");

const started = Date.now();
const chunks = [];
for await (const chunk of stream({
	provider: "devin-direct",
	model: "deepseek-v4-1-flash-1017-high",
	messages: [{ role: "user", id: "u1", content: [{ type: "text", text: "hi" }] }]
})) {
	chunks.push(chunk);
}

const finish = chunks.find((c) => c.type === "finish");
const kinds = [...new Set(chunks.map((c) => c.type))].join(",");
console.log(`chunks: ${kinds}`);
console.log(`finish: ${JSON.stringify(finish?.reason)}`);
console.log(`elapsed: ${Date.now() - started}ms`);

const ok =
	finish?.reason?.kind === "error" &&
	typeof finish.reason.failure?.message === "string" &&
	finish.reason.failure.message.length > 0;

console.log(ok ? "\nRESULT: PASS — clean error chunk with a message" : "\nRESULT: FAIL — error path did not surface cleanly");
process.exit(ok ? 0 : 1);
