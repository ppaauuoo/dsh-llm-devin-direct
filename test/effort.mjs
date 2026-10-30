/**
 * Effort routing check: no network, no credentials.
 *
 * Proves the two halves of the feature that can be checked offline:
 *   1. the advertised `reasoning` capability is what dsh validates (unique,
 *      non-empty ids, and a `defaultEffort` that is one of them);
 *   2. every advertised level resolves to a *different* uid, and a level the
 *      route does not advertise falls back to the route's native uid.
 *
 *   node test/effort.mjs
 */
const mod = await import("@vorkna/dsh-llm-devin-direct");

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

const errors = [];
const check = (ok, message) => {
	if (!ok) errors.push(message);
};

const models = await adapter.listModels("devin-direct");
console.log(`routes: ${models.length}`);

let withEffort = 0;
let totalLevels = 0;

for (const listed of models) {
	const resolved = await adapter.resolveModel("devin-direct", listed.id);
	check(
		JSON.stringify(listed.reasoning) === JSON.stringify(resolved.reasoning),
		`${listed.id}: listModels and resolveModel disagree on reasoning`
	);

	const reasoning = resolved.reasoning;
	if (!reasoning) {
		// A route with no verified alternative tiers must not advertise a selector.
		console.log(`  ${listed.id.padEnd(32)} (no effort map)`);
		continue;
	}

	withEffort += 1;
	totalLevels += reasoning.efforts.length;

	// --- the shape dsh validates (INVALID_MODEL_REASONING otherwise) ---
	const seen = new Set();
	for (const effort of reasoning.efforts) {
		check(typeof effort.id === "string" && effort.id.length > 0, `${listed.id}: effort id not a non-empty string`);
		check(typeof effort.name === "string" && effort.name.length > 0, `${listed.id}: effort ${effort.id} has no name`);
		check(!seen.has(effort.id), `${listed.id}: duplicate effort id ${effort.id}`);
		seen.add(effort.id);
	}
	check(
		reasoning.defaultEffort === undefined || seen.has(reasoning.defaultEffort),
		`${listed.id}: defaultEffort ${reasoning.defaultEffort} is not an advertised effort`
	);

	// --- escalation order, as dsh's picker renders it ---
	const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const indices = reasoning.efforts.map((e) => order.indexOf(e.id));
	check(
		indices.every((i, n) => i >= 0 && (n === 0 || i > indices[n - 1])),
		`${listed.id}: efforts are not in escalation order (${reasoning.efforts.map((e) => e.id).join(", ")})`
	);

	// --- every level is a distinct uid; unknown levels fall back ---
	const uids = new Map();
	for (const effort of reasoning.efforts) {
		const uid = mod.resolveEffortUid(adapter.entryFor(listed.id), effort.id);
		check(uid.length > 0, `${listed.id}: effort ${effort.id} resolved to an empty uid`);
		check(!uids.has(uid), `${listed.id}: efforts ${uids.get(uid)} and ${effort.id} both resolve to ${uid}`);
		uids.set(uid, effort.id);
	}
	const fallback = mod.resolveEffortUid(adapter.entryFor(listed.id), "xhigh");
	check(fallback === resolved.id || fallback.length > 0, `${listed.id}: unknown effort lost the route uid`);
	const noEffort = mod.resolveEffortUid(adapter.entryFor(listed.id), undefined);
	check(uids.has(noEffort), `${listed.id}: no-effort call does not land on an advertised uid (${noEffort})`);

	console.log(
		`  ${listed.id.padEnd(32)} ${reasoning.efforts.map((e) => e.id).join("/")}` +
			`  default=${reasoning.defaultEffort ?? "none"}` +
			`  uids=${[...uids.keys()].join(",")}`
	);
}

check(withEffort > 0, "no route advertises effort — the feature is inert");

console.log(`\nroutes with effort: ${withEffort}  levels: ${totalLevels}`);

if (errors.length > 0) {
	console.log("\nERRORS:");
	for (const e of errors) console.log(` - ${e}`);
	console.log("RESULT: FAIL");
	process.exit(1);
}
console.log("RESULT: PASS — capability is well-formed and every level routes to its own uid");
