/**
 * Does the endpoint actually honour an effort uid, or silently serve something
 * else? `GetChatMessageResponse` carries no `actual_model_uid`, so the signal is
 * acceptance: an unknown uid is refused with
 * "This model is no longer available for your account", while a real one answers.
 *
 * That makes the check two-sided, and the control matters as much as the probe:
 *   - a bogus uid MUST be rejected, or acceptance proves nothing;
 *   - every uid the plugin advertises MUST be accepted.
 *
 *   node test/effort-wire.mjs          # every advertised level
 *   node test/effort-wire.mjs swe-2-max
 */
import { readCredentials, credentialsPath, resolveClientVersion, streamChatEvents } from "../lib/protocol.js";

const mod = await import("@vorkna/dsh-llm-devin-direct");

const creds = readCredentials(credentialsPath());
if (!creds) {
	console.error(`no credentials at ${credentialsPath()}`);
	process.exit(1);
}

/**
 * true = accepted, false = refused, null = no usable signal.
 *
 * The cap has to be generous: a reasoning route spends its budget thinking
 * before it emits any text, so a tight cap produces a truncated turn that looks
 * like a missing model. Acceptance is therefore "text or a clean finish" — an
 * empty answer is not a rejection, but a refusal message is.
 */
async function probe(uid) {
	let failure = null;
	let usable = false;
	try {
		for await (const ev of streamChatEvents({
			apiKey: creds.apiKey,
			host: creds.apiServerUrl,
			ide: "devin-desktop",
			version: resolveClientVersion(""),
			modelUid: uid,
			systemPrompt: "Reply with the single word: ok",
			messages: [{ role: "user", content: "ping" }],
			maxOutputTokens: 512
		})) {
			if (ev.kind === "text" || ev.kind === "finish") usable = true;
			if (ev.kind === "finish" && ev.reason.kind === "error") failure = ev.reason.failure.message;
		}
	} catch (e) {
		failure = String(e.message);
	}
	if (failure) {
		// A refusal is an answer about the uid; a transport fault is not.
		return /no longer available|not found|unknown model|invalid model/i.test(failure) ? false : null;
	}
	return usable ? true : null;
}

/** One retry, so a transient fault is not reported as a missing model. */
async function probeWithRetry(uid) {
	const first = await probe(uid);
	if (first !== null) return first;
	await new Promise((r) => setTimeout(r, 1500));
	return probe(uid);
}

// --- the control: a uid that cannot exist must be refused ---
const bogus = "gpt-6-1-sol-definitely-not-a-tier";
const bogusResult = await probeWithRetry(bogus);
const controlOk = bogusResult === false;
console.log(`control  ${bogus.padEnd(36)} ${bogusResult === false ? "refused" : bogusResult === true ? "ACCEPTED" : "no signal"}`);

// --- collect the uids the plugin advertises ---
const explicit = process.argv.slice(2);
let targets;
if (explicit.length > 0) {
	targets = explicit.map((uid) => ({ uid, route: "(explicit)" }));
} else {
	let adapter;
	mod.apply(
		{ effect: (fn) => fn(), llm: { registerAdapter: (_i, a) => (adapter = a), registerConfigurableProviders: () => {} } },
		new mod.Config({})
	);
	targets = [];
	for (const listed of await adapter.listModels("devin-direct")) {
		const entry = adapter.entryFor(listed.id);
		for (const level of mod.effortLevels(entry)) {
			targets.push({ uid: mod.resolveEffortUid(entry, level), route: `${listed.id}:${level}` });
		}
	}
}

const errors = [];
if (!controlOk) {
	errors.push(
		bogusResult === true
			? "the endpoint accepted a bogus uid, so acceptance cannot distinguish a real tier from a fallback — routing is unverifiable"
			: "the control uid got no signal (transport error), so this run proves nothing"
	);
}

for (const { uid, route } of targets) {
	const accepted = await probeWithRetry(uid);
	if (accepted === true) console.log(`  ok      ${uid.padEnd(36)} ${route}`);
	else {
		console.log(`  FAIL    ${uid.padEnd(36)} ${route} ${accepted === false ? "(refused)" : "(no signal)"}`);
		errors.push(`${route} advertises ${uid}, which the endpoint ${accepted === false ? "refused" : "did not answer"}`);
	}
}

console.log(`\nadvertised uids checked: ${targets.length}`);
if (errors.length > 0) {
	console.log("");
	for (const e of errors) console.log(` - ${e}`);
	console.log("RESULT: FAIL");
	process.exit(1);
}
console.log("RESULT: PASS — control refused, every advertised uid accepted");
