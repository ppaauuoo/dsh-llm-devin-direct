/**
 * Devin/Cognition local-tier model protocol: auth (Windsurf API key -> user
 * JWT), GetChatMessage request encoding, and the streaming response decoder.
 *
 * Ported from pi-devin-local (src/metadata.ts, src/jwt.ts, src/stream.ts) with
 * the pi-ai message types replaced by plain objects.
 *
 * This speaks to the same endpoint Devin Desktop/CLI use internally:
 *   POST {host}/exa.api_server_pb.ApiServerService/GetChatMessage
 * with Connect-Protocol protobuf framing. It is undocumented and may change.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as zlib from "node:zlib";
import {
	encodeFixed64Field,
	encodeMessage,
	encodeString,
	encodeVarintField,
	frameConnectStream,
	iterFields
} from "./wire.js";

export const DEFAULT_HOST = "https://server.codeium.com";
export const FALLBACK_CLIENT_VERSION = "3.10.27";

export function credentialsPath() {
	return join(homedir(), ".local/share/devin/credentials.toml");
}

function parseTomlStrings(text) {
	const out = {};
	for (const line of text.split("\n")) {
		const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/);
		if (match) out[match[1]] = match[2];
	}
	return out;
}

/** Read `windsurf_api_key` (and friends) from the Devin CLI credential store. */
export function readCredentials(path = credentialsPath()) {
	if (!existsSync(path)) return null;
	const parsed = parseTomlStrings(readFileSync(path, "utf8"));
	const apiKey = parsed.windsurf_api_key;
	if (!apiKey) return null;
	return {
		apiKey,
		apiServerUrl: parsed.api_server_url || DEFAULT_HOST,
		webappHost: parsed.devin_webapp_host || "app.devin.ai",
		apiUrl: parsed.devin_api_url || "https://api.devin.ai",
		path
	};
}

/** The desktop build's version string — the server validates it. */
export function resolveClientVersion(explicit) {
	if (explicit) return explicit;
	const candidates = [
		join(process.env.LOCALAPPDATA ?? "", "Programs/Devin/resources/app/product.json"),
		"/Applications/Devin.app/Contents/Resources/app/product.json"
	];
	for (const path of candidates) {
		try {
			if (!existsSync(path)) continue;
			const product = JSON.parse(readFileSync(path, "utf8"));
			if (product.windsurfVersion) return product.windsurfVersion;
		} catch {
			// keep looking
		}
	}
	return FALLBACK_CLIENT_VERSION;
}

/**
 * Cognition gates Devin Local-only models by client ide name: with
 * ide="windsurf" they are rejected with "This model is only in Devin Local.";
 * with ide="devin-desktop" the server serves them.
 */
export function buildMetadata(input) {
	const ide = input.ide;
	const version = input.version;
	const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
	const parts = [
		encodeString(1, ide),
		encodeString(2, version),
		encodeString(3, input.apiKey),
		encodeString(4, "en"),
		encodeString(5, os),
		encodeString(7, version),
		encodeVarintField(9, input.requestId),
		encodeString(10, input.sessionId),
		encodeString(12, ide),
		encodeMessage(16, encodeTimestampBodyLocal()),
		encodeString(25, input.triggerId),
		encodeString(26, "Unset"),
		encodeString(28, ide)
	];
	if (input.userJwt) parts.push(encodeString(21, input.userJwt));
	return Buffer.concat(parts);
}

function encodeTimestampBodyLocal() {
	const now = Date.now();
	const seconds = Math.floor(now / 1000);
	const nanos = (now % 1000) * 1e6;
	return Buffer.concat([
		encodeVarintField(1, seconds),
		nanos > 0 ? encodeVarintField(2, nanos) : Buffer.alloc(0)
	]);
}

export async function mintUserJwt({ apiKey, host, ide, version, signal }) {
	const metadata = buildMetadata({
		apiKey,
		ide,
		version,
		sessionId: randomUUID(),
		requestId: BigInt(Date.now()),
		triggerId: randomUUID()
	});
	const timeout = AbortSignal.timeout(30_000);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const resp = await fetch(`${host.replace(/\/$/, "")}/exa.auth_pb.AuthService/GetUserJwt`, {
		method: "POST",
		headers: {
			"Content-Type": "application/proto",
			"Connect-Protocol-Version": "1"
		},
		body: new Uint8Array(encodeMessage(1, metadata)),
		signal: combined
	});
	const buf = Buffer.from(await resp.arrayBuffer());
	if (!resp.ok) throw new Error(`GetUserJwt HTTP ${resp.status}: ${buf.toString("utf8").slice(0, 240)}`);

	let jwt = null;
	for (const field of iterFields(buf)) {
		if (field.num === 1 && field.wire === 2 && Buffer.isBuffer(field.value)) {
			const value = field.value.toString("utf8");
			if (value.startsWith("eyJ")) {
				jwt = value;
				break;
			}
		}
	}
	if (!jwt) throw new Error("GetUserJwt returned no JWT");

	let expiresAt = Math.floor(Date.now() / 1000) + 600;
	try {
		const payload = jwt.split(".")[1] ?? "";
		const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
		const parsed = JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
		if (typeof parsed.exp === "number") expiresAt = parsed.exp;
	} catch {
		// keep fallback
	}
	return { jwt, expiresAt };
}

let jwtCache = null;
const jwtInFlight = new Map();

export async function getCachedUserJwt({ apiKey, host, ide, version, signal }) {
	const now = Math.floor(Date.now() / 1000);
	if (jwtCache && jwtCache.apiKey === apiKey && jwtCache.host === host && jwtCache.expiresAt > now + 60) {
		return jwtCache.jwt;
	}
	const key = `${host}\x1f${apiKey}`;
	const existing = jwtInFlight.get(key);
	if (existing) return (await existing).jwt;
	const promise = mintUserJwt({ apiKey, host, ide, version, signal });
	jwtInFlight.set(key, promise);
	try {
		const minted = await promise;
		jwtCache = { jwt: minted.jwt, expiresAt: minted.expiresAt, apiKey, host };
		return minted.jwt;
	} finally {
		jwtInFlight.delete(key);
	}
}

const SOURCE_BY_ROLE = { user: 1, assistant: 2, tool: 4 };

function encodeChatToolCall(tc) {
	return Buffer.concat([encodeString(1, tc.id), encodeString(2, tc.name), encodeString(3, tc.arguments)]);
}

function normalizeContent(content) {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content : [];
}

function encodeChatMessagePrompt(rawContent, source, opts) {
	const content = normalizeContent(rawContent);
	const text = content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
	const parts = [
		encodeVarintField(2, source),
		encodeString(3, text),
		encodeVarintField(4, Math.max(1, Math.floor(text.length / 4))),
		encodeVarintField(5, 1)
	];
	if (opts?.toolCallId) parts.push(encodeString(7, opts.toolCallId));
	for (const tc of opts?.toolCalls ?? []) parts.push(encodeMessage(6, encodeChatToolCall(tc)));
	for (const img of content.filter((part) => part.type === "image")) {
		parts.push(
			encodeMessage(
				10,
				Buffer.concat([encodeString(1, img.base64Data ?? ""), encodeString(2, img.mimeType ?? "image/png")])
			)
		);
	}
	if (opts?.thinking) {
		parts.push(encodeString(11, opts.thinking.text));
		parts.push(encodeString(12, opts.thinking.signature));
		if (opts.thinking.redacted) parts.push(encodeVarintField(13, 1));
		if (opts.thinking.signatureType) parts.push(encodeString(18, opts.thinking.signatureType));
	}
	return Buffer.concat(parts);
}

function encodeCompletionConfiguration(maxOutputTokens) {
	return Buffer.concat([
		encodeVarintField(1, 1),
		encodeVarintField(2, maxOutputTokens ?? 128_000),
		encodeVarintField(3, 400),
		encodeFixed64Field(5, 1.0),
		encodeVarintField(7, 40),
		encodeFixed64Field(8, 0.95)
	]);
}

function encodeTrajectoryReference(trajectoryId) {
	return Buffer.concat([encodeString(1, trajectoryId), encodeVarintField(3, 4), encodeVarintField(4, 14)]);
}

function encodeToolDef(tool) {
	const description = tool.description.length > 6_998 ? `${tool.description.slice(0, 6_995)}...` : tool.description;
	return Buffer.concat([
		encodeString(1, tool.name),
		encodeString(2, description),
		encodeString(3, JSON.stringify(tool.parameters ?? {}))
	]);
}

export function buildGetChatMessageRequest(args) {
	const metadata = buildMetadata({
		apiKey: args.apiKey,
		userJwt: args.userJwt,
		ide: args.ide,
		version: args.version,
		sessionId: args.sessionId,
		requestId: args.requestId,
		triggerId: args.triggerId
	});
	const prompts = args.messages.map((message) =>
		encodeMessage(
			3,
			encodeChatMessagePrompt(message.content, SOURCE_BY_ROLE[message.role] ?? 1, {
				toolCallId: message.role === "tool" ? message.tool_call_id : undefined,
				toolCalls: message.role === "assistant" ? message.tool_calls : undefined,
				thinking: message.role === "assistant" ? message.thinking : undefined
			})
		)
	);
	return Buffer.concat([
		encodeMessage(1, metadata),
		...(args.systemPrompt ? [encodeString(2, args.systemPrompt)] : []),
		...prompts,
		encodeVarintField(7, 5),
		encodeMessage(8, encodeCompletionConfiguration(args.maxOutputTokens)),
		...(args.tools ?? []).map((tool) => encodeMessage(10, encodeToolDef(tool))),
		encodeMessage(15, encodeTrajectoryReference(args.trajectoryId)),
		encodeString(16, args.cascadeId),
		encodeVarintField(20, 1),
		encodeString(21, args.modelUid)
	]);
}

function* decodeChatFrame(proto) {
	let signature;
	let signatureType;
	for (const field of iterFields(proto)) {
		if (field.num === 3 && field.wire === 2 && Buffer.isBuffer(field.value)) {
			const text = field.value.toString("utf8");
			if (text) yield { kind: "text", text };
		} else if (field.num === 9 && field.wire === 2 && Buffer.isBuffer(field.value)) {
			const text = field.value.toString("utf8");
			if (text) yield { kind: "reasoning", text };
		} else if (field.num === 11 && field.wire === 0) {
			if (Number(field.value) !== 0) yield { kind: "reasoning_redacted" };
		} else if (field.num === 10 && field.wire === 2 && Buffer.isBuffer(field.value)) {
			const text = field.value.toString("utf8");
			if (text) signature = text;
		} else if (field.num === 21 && field.wire === 2 && Buffer.isBuffer(field.value)) {
			const text = field.value.toString("utf8");
			if (text) signatureType = text;
		} else if (field.num === 6 && field.wire === 2 && Buffer.isBuffer(field.value)) {
			let id;
			let name;
			let argsDelta;
			for (const inner of iterFields(field.value)) {
				if (inner.wire === 2 && Buffer.isBuffer(inner.value)) {
					const text = inner.value.toString("utf8");
					if (inner.num === 1) id = text;
					else if (inner.num === 2) name = text;
					else if (inner.num === 3) argsDelta = text;
				}
			}
			if (id !== undefined && name !== undefined) yield { kind: "tool_call_start", id, name };
			if (argsDelta !== undefined) yield { kind: "tool_call_args", argsDelta, ...(id ? { id } : {}) };
		} else if (field.num === 5 && field.wire === 0) {
			const value = Number(field.value);
			let reason = "stop";
			if (value === 10) reason = "tool_calls";
			else if (value === 11) reason = "content_filter";
			else if (value === 1 || value === 3) reason = "length";
			yield { kind: "finish", reason };
		} else if (field.num === 28 && field.wire === 2 && Buffer.isBuffer(field.value)) {
			const usage = decodeUsage(field.value);
			if (usage) yield usage;
		}
	}
	if (signature) yield { kind: "reasoning_signature", signature, signatureType };
}

function decodeUsage(buf) {
	let promptTokens;
	let completionTokens;
	let cachedInputTokens;
	let cacheCreationInputTokens;
	for (const field of iterFields(buf)) {
		if (field.num !== 2 || field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
		let metric;
		let value;
		for (const inner of iterFields(field.value)) {
			if (inner.num === 5 && inner.wire === 2 && Buffer.isBuffer(inner.value)) {
				metric = inner.value.toString("utf8");
			} else if (inner.num === 4 && inner.wire === 2 && Buffer.isBuffer(inner.value)) {
				for (const dim of iterFields(inner.value)) {
					if (dim.num === 2 && dim.wire === 5 && Buffer.isBuffer(dim.value)) {
						value = dim.value.readFloatLE(0);
					}
				}
			}
		}
		if (!metric || value === undefined || !Number.isFinite(value)) continue;
		const n = Math.round(value);
		if (metric === "input_tokens") promptTokens = n;
		else if (metric === "output_tokens") completionTokens = n;
		else if (metric.includes("cached") || metric.includes("cache_read")) cachedInputTokens = n;
		else if (metric.includes("cache_creation")) cacheCreationInputTokens = n;
	}
	if (promptTokens === undefined && completionTokens === undefined) return null;
	return {
		kind: "usage",
		promptTokens,
		completionTokens,
		totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
		cachedInputTokens,
		cacheCreationInputTokens
	};
}

const sessionCache = new Map();

function sessionIds(apiKey, host) {
	const key = `${host}\x1f${apiKey}`;
	let ids = sessionCache.get(key);
	if (!ids) {
		ids = { sessionId: randomUUID(), cascadeId: randomUUID(), trajectoryId: randomUUID() };
		sessionCache.set(key, ids);
	}
	return ids;
}

/** One GetChatMessage round trip, decoded into protocol events. */
export async function* streamChatEvents(args) {
	const host = args.host.replace(/\/$/, "");
	const userJwt = await getCachedUserJwt({
		apiKey: args.apiKey,
		host,
		ide: args.ide,
		version: args.version,
		signal: args.signal
	});
	const ids = sessionIds(args.apiKey, host);
	const proto = buildGetChatMessageRequest({
		apiKey: args.apiKey,
		userJwt,
		ide: args.ide,
		version: args.version,
		modelUid: args.modelUid,
		systemPrompt: args.systemPrompt,
		messages: args.messages,
		tools: args.tools,
		cascadeId: ids.cascadeId,
		trajectoryId: ids.trajectoryId,
		sessionId: ids.sessionId,
		requestId: BigInt(Date.now()),
		triggerId: randomUUID(),
		maxOutputTokens: args.maxOutputTokens
	});

	const resp = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
		method: "POST",
		headers: {
			"Content-Type": "application/connect+proto",
			"Connect-Protocol-Version": "1",
			"Connect-Content-Encoding": "gzip",
			"Connect-Accept-Encoding": "gzip"
		},
		body: new Uint8Array(frameConnectStream(proto, true)),
		signal: args.signal
	});
	if (!resp.ok) {
		throw new Error(`GetChatMessage HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
	}
	if (!resp.body) throw new Error("GetChatMessage returned an empty body");

	let buf = Buffer.alloc(0);
	let sawEos = false;
	let trailerError = null;

	for await (const chunk of resp.body) {
		buf = Buffer.concat([buf, Buffer.from(chunk)]);
		while (buf.length >= 5) {
			const flags = buf[0];
			const len = buf.readUInt32BE(1);
			if (buf.length < 5 + len) break;
			const raw = buf.subarray(5, 5 + len);
			buf = buf.subarray(5 + len);
			let payload = raw;
			if (flags & 0x01) payload = zlib.gunzipSync(raw);
			if (flags & 0x02) {
				sawEos = true;
				const text = payload.toString("utf8");
				if (text.includes('"error"')) {
					try {
						const parsed = JSON.parse(text);
						trailerError = parsed.error?.message ?? text;
					} catch {
						trailerError = text;
					}
				}
				continue;
			}
			yield* decodeChatFrame(payload);
		}
	}

	if (trailerError) throw new Error(trailerError);
	if (!sawEos) throw new Error("Devin stream ended without an EOS trailer");
}
