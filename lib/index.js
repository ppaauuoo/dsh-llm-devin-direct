/**
 * `devin-direct` — a dsh LLM provider that talks to the Devin/Cognition model
 * endpoint directly instead of spawning `devin acp`.
 *
 * Why this exists: the ACP provider hands each call to a complete Devin agent
 * with its own fixed toolset. This adapter is a plain model provider — it sends
 * the harness's own tool schemas in the request and streams back text,
 * reasoning and tool calls for dsh to execute. No Devin tools, no agent loop.
 *
 * Auth + endpoint are the ones Devin Desktop/CLI use internally
 * (`~/.local/share/devin/credentials.toml` -> GetUserJwt -> GetChatMessage).
 * That endpoint is undocumented; treat breakage as expected maintenance.
 */
import Schema from "@deepseek-ai/schemastery";
import { readFile } from "node:fs/promises";
import {
	DEFAULT_HOST,
	credentialsPath,
	readCredentials,
	resolveClientVersion,
	streamChatEvents
} from "./protocol.js";

const name = "@vorkna/dsh-llm-devin-direct";
const inject = ["llm"];

/**
 * The wire has no effort field: `GetChatMessageRequest` carries none, and the
 * server's own `ModelInfo.inference_config.reasoning_effort` is not something a
 * client sets. Effort is selected by the model uid itself (`-high`, `-max`), so
 * an effort map is just uid routing.
 *
 * The ladders below were probed against the live endpoint. The endpoint rejects
 * an unknown uid with "This model is no longer available for your account", so
 * an accepted uid is a real model rather than a silent fallback. `off` and
 * `minimal` do not exist for any route, and the ladders are not uniform: SWE-2
 * starts at `medium`, DeepSeek V4.1 Flash skips `medium` and `xhigh`. Only list
 * what answered — an advertised level that the server does not know is a lie
 * the picker cannot see.
 */
function ladder(base, levels) {
	return Object.fromEntries(levels.map((level) => [level, `${base}-${level}`]));
}

const SOL_EFFORTS = ladder("gpt-6-1-sol", ["low", "medium", "high", "xhigh", "max"]);
const OPUS_EFFORTS = ladder("claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"]);
const SONNET_EFFORTS = ladder("claude-sonnet-5-5", ["low", "medium", "high", "xhigh", "max"]);
const LUNA_EFFORTS = ladder("gpt-6-luna", ["low", "medium", "high", "xhigh", "max"]);
const SWE2_EFFORTS = ladder("swe-2", ["medium", "high", "max"]);
const DEEPSEEK_EFFORTS = ladder("deepseek-v4-1-flash-1017", ["low", "high", "max"]);

const DEFAULT_MODELS = [
	{
		id: "deepseek-v4-1-flash-1017-high",
		devinModel: "deepseek-v4-1-flash-1017-high",
		name: "DeepSeek V4.1 Flash",
		efforts: DEEPSEEK_EFFORTS
	},
	{ id: "gpt-6-1-sol-high", devinModel: "gpt-6-1-sol-high", name: "GPT-6.1 Sol", efforts: SOL_EFFORTS },
	{ id: "gpt-6-1-sol-max", devinModel: "gpt-6-1-sol-max", name: "GPT-6.1 Sol Max", efforts: SOL_EFFORTS },
	{ id: "claude-opus-5-5-high", devinModel: "claude-opus-5-5-high", name: "Claude Opus 5.5", efforts: OPUS_EFFORTS },
	{
		id: "claude-sonnet-5-5-high",
		devinModel: "claude-sonnet-5-5-high",
		name: "Claude Sonnet 5.5",
		efforts: SONNET_EFFORTS
	},
	{ id: "swe-2-high", devinModel: "swe-2-high", name: "SWE-2", efforts: SWE2_EFFORTS },
	{ id: "gpt-6-luna-high", devinModel: "gpt-6-luna-high", name: "GPT-6 Luna", efforts: LUNA_EFFORTS }
];

const EFFORT_LABELS = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max"
};

/**
 * The effort levels a route advertises, in dsh's escalation order.
 *
 * A route with no effort map advertises nothing, which is the honest answer for
 * uids whose other tiers are unverified: dsh then hides the selector instead of
 * offering a choice that silently resolves to the same uid.
 */
export function effortLevels(entry) {
	const map = entry?.efforts ?? {};
	return Object.keys(EFFORT_LABELS).filter((level) => map[level]);
}

/** The route's native tier: the level whose uid *is* `devinModel`. */
export function defaultEffort(entry) {
	const levels = effortLevels(entry);
	if (levels.length === 0) return undefined;
	const map = entry.efforts;
	return levels.find((level) => map[level] === entry.devinModel) ?? levels[0];
}

/** Effort level + route -> the uid the wire actually sends. */
export function resolveEffortUid(entry, effort) {
	if (!entry) return effort ?? "";
	const map = entry.efforts ?? {};
	if (effort && map[effort]) return map[effort];
	return entry.devinModel || entry.id;
}

const Config = Schema.object({
	apiKey: Schema.string().default("").description("Windsurf API key; empty reads the Devin CLI credential store").volatile(),
	credentialsPath: Schema.string().default("").description("Override the credentials.toml path").volatile(),
	host: Schema.string().default(DEFAULT_HOST).description("API server host").volatile(),
	clientIde: Schema.string().default("devin-desktop").description("Client ide name the server gates local models on").volatile(),
	clientVersion: Schema.string().default("").description("Desktop version string; empty reads product.json").volatile(),
	models: Schema.array(
		Schema.object({
			id: Schema.string(),
			devinModel: Schema.string().default(""),
			name: Schema.string().default(""),
			efforts: Schema.dict(Schema.string()).default({})
		})
	).default(DEFAULT_MODELS).volatile(),
	maxOutputTokens: Schema.number().default(128_000).volatile(),
	timeoutMs: Schema.number().default(900_000).volatile(),
	maxImages: Schema.number().default(8).volatile(),
	maxImageBytes: Schema.number().default(5_242_880).volatile()
});

/**
 * Resolve the harness image blocks this request can carry to wire image parts.
 * The attachment store is optional: without it (or without `read_image`) the
 * transcript simply has no image blocks.
 */
async function collectImages(ctx, messages, maxImages, maxImageBytes) {
	const map = new Map();
	let store;
	try {
		store = ctx?.get?.("attachments");
	} catch {
		store = undefined;
	}
	if (!store) return map;

	const candidates = [];
	for (const message of messages) {
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block?.type === "image" && !block.offloaded) candidates.push(block);
		}
	}

	for (const block of candidates.slice(-maxImages)) {
		try {
			const attachment = block.attachment;
			if (!attachment || attachment.bytes > maxImageBytes) continue;
			const path = store.imageHostPath(attachment);
			if (!path) continue;
			const data = await readFile(path);
			if (data.byteLength > maxImageBytes) continue;
			map.set(block, {
				type: "image",
				base64Data: data.toString("base64"),
				mimeType: attachment.mediaType || "image/png"
			});
		} catch {
			// An unreadable attachment degrades to its text placeholder, never to a failed turn.
		}
	}
	return map;
}

/** dsh message blocks -> the wire's chat history items. */
function mapMessages(messages, images) {
	const out = [];
	for (const message of messages) {
		const blocks = Array.isArray(message.content) ? message.content : [];
		if (message.role === "user") {
			const text = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			const parts = [];
			if (text) parts.push({ type: "text", text });
			for (const block of blocks) {
				const image = images?.get(block);
				if (image) parts.push(image);
			}
			const hasImage = parts.some((part) => part.type === "image");
			out.push({ role: "user", content: hasImage ? parts : text });
		} else if (message.role === "assistant") {
			const texts = [];
			const toolCalls = [];
			for (const block of blocks) {
				if (block.type === "text") texts.push(block.text);
				else if (block.type === "tool-call") {
					toolCalls.push({
						id: String(block.id),
						name: block.name,
						arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {})
					});
				}
			}
			out.push({
				role: "assistant",
				content: texts.join("\n"),
				tool_calls: toolCalls.length > 0 ? toolCalls : undefined
			});
		} else if (message.role === "tool") {
			const text = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			// Tool results can carry images (`read_image`), and the wire encodes them
			// per-prompt regardless of source. Dropping them here would make a tool
			// the model called itself silently invisible.
			const parts = [];
			if (text) parts.push({ type: "text", text });
			for (const block of blocks) {
				const image = images?.get(block);
				if (image) parts.push(image);
			}
			const hasImage = parts.some((part) => part.type === "image");
			out.push({
				role: "tool",
				content: hasImage ? parts : text,
				tool_call_id: String(message.toolCallId ?? "")
			});
		}
	}
	return out;
}

function mapTools(tools) {
	return (tools ?? []).map((tool) => ({
		name: tool.name,
		description: tool.description ?? "",
		parameters: tool.parameters ?? { type: "object", properties: {} }
	}));
}

class DevinDirectAdapter {
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
	}

	/**
	 * cordis materializes a plugin's Config into reactive refs (`.get()`), while
	 * a plain `new Config(...)` yields raw values. Read either shape.
	 */
	field(key) {
		const value = this.config?.[key];
		return typeof value?.get === "function" ? value.get() : value;
	}

	providerInfo(provider) {
		return { id: provider, name: "Devin Direct" };
	}

	providerRetryPolicy() {}

	imageRequestPricing() {}

	modalities() {
		return ["text", "image"];
	}

	resolveKey() {
		const explicit = this.field("apiKey");
		if (explicit) return explicit;
		const path = this.field("credentialsPath") || credentialsPath();
		const creds = readCredentials(path);
		if (!creds) {
			throw new Error(
				`devin-direct: no API key. Set the plugin's apiKey, or sign in with \`devin auth login\` (expected ${path}).`
			);
		}
		return creds.apiKey;
	}

	modelTable() {
		return this.field("models") ?? [];
	}

	/** The route entry, or a synthesised one for a route the table does not list. */
	entryFor(routeId) {
		return this.modelTable().find((m) => m.id === routeId) ?? { id: routeId, devinModel: "", name: "" };
	}

	resolveModelUid(routeId) {
		return this.entryFor(routeId).devinModel || routeId;
	}

	/** The `reasoning` capability dsh validates and renders, or nothing. */
	reasoningFor(entry) {
		const levels = effortLevels(entry);
		if (levels.length === 0) return undefined;
		const fallback = defaultEffort(entry);
		return {
			efforts: levels.map((level) => ({
				id: level,
				name: EFFORT_LABELS[level],
				description: `Sends ${entry.efforts[level]}`
			})),
			...(fallback ? { defaultEffort: fallback } : {})
		};
	}

	async listModels(provider) {
		return this.modelTable().map((entry) => {
			const reasoning = this.reasoningFor(entry);
			return {
				provider,
				id: entry.id,
				name: entry.name || entry.id,
				description: `Devin model ${entry.devinModel || entry.id} — direct stream, harness tools`,
				inputModalities: this.modalities(),
				...(reasoning ? { reasoning } : {})
			};
		});
	}

	async resolveModel(provider, model) {
		const entry = this.entryFor(model);
		const reasoning = this.reasoningFor(entry);
		return {
			provider,
			id: model,
			name: entry.name || model,
			inputModalities: this.modalities(),
			...(reasoning ? { reasoning } : {})
		};
	}

	async prepareCall(provider, model) {
		return {
			model: await this.resolveModel(provider, model),
			stream: (options) => this.stream(options)
		};
	}

	async *stream(options) {
		const timeout = AbortSignal.timeout(this.field("timeoutMs"));
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

		let nextIndex = 0;
		let textIndex = -1;
		let textAcc = "";
		let reasoningIndex = -1;
		let reasoningAcc = "";
		const toolBlocks = new Map();
		let lastToolId = "";
		let usage = null;
		let finishReason = "stop";

		const closeOpen = function* () {
			if (textIndex >= 0) {
				yield { type: "block-end", index: textIndex, block: { type: "text", text: textAcc } };
				textIndex = -1;
			}
			if (reasoningIndex >= 0) {
				yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoningAcc } };
				reasoningIndex = -1;
			}
			for (const block of toolBlocks.values()) {
				if (block.closed) continue;
				block.closed = true;
				yield {
					type: "block-end",
					index: block.index,
					block: { type: "tool-call", id: block.id, name: block.name, arguments: block.arguments }
				};
			}
		};

		try {
			const images = await collectImages(
				this.ctx,
				options.messages,
				this.field("maxImages"),
				this.field("maxImageBytes")
			);
			const events = streamChatEvents({
				apiKey: this.resolveKey(),
				host: this.field("host"),
				ide: this.field("clientIde"),
				version: resolveClientVersion(this.field("clientVersion")),
				modelUid: resolveEffortUid(this.entryFor(options.model), options.reasoningEffort),
				systemPrompt: options.system,
				messages: mapMessages(options.messages, images),
				tools: mapTools(options.tools),
				maxOutputTokens: this.field("maxOutputTokens"),
				signal
			});

			for await (const event of events) {
				if (event.kind === "text") {
					if (textIndex < 0) {
						textIndex = nextIndex++;
						textAcc = "";
						yield { type: "block-start", index: textIndex, blockType: "text" };
					}
					textAcc += event.text;
					yield { type: "text-delta", index: textIndex, text: event.text };
				} else if (event.kind === "reasoning") {
					if (reasoningIndex < 0) {
						reasoningIndex = nextIndex++;
						reasoningAcc = "";
						yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" };
					}
					reasoningAcc += event.text;
					yield { type: "reasoning-delta", index: reasoningIndex, text: event.text };
				} else if (event.kind === "tool_call_start") {
					if (toolBlocks.has(event.id)) continue;
					const index = nextIndex++;
					toolBlocks.set(event.id, { index, id: event.id, name: event.name, arguments: "", closed: false });
					lastToolId = event.id;
					yield { type: "block-start", index, blockType: "tool-call" };
					yield { type: "tool-call-delta", index, id: event.id, name: event.name, argumentsDelta: "" };
				} else if (event.kind === "tool_call_args") {
					const id = event.id ?? lastToolId;
					const block = toolBlocks.get(id) ?? [...toolBlocks.values()].at(-1);
					if (!block || block.closed) continue;
					block.arguments += event.argsDelta;
					yield {
						type: "tool-call-delta",
						index: block.index,
						id: block.id,
						argumentsDelta: event.argsDelta
					};
				} else if (event.kind === "usage") {
					usage = {
						inputTokens: event.promptTokens ?? 0,
						outputTokens: event.completionTokens ?? 0,
						totalTokens: event.totalTokens,
						...(event.cachedInputTokens !== undefined ? { cacheReadTokens: event.cachedInputTokens } : {})
					};
				} else if (event.kind === "finish") {
					finishReason = event.reason;
				}
			}

			yield* closeOpen();
			if (usage) yield { type: "usage", usage };

			const hasToolCalls = toolBlocks.size > 0;
			const reason =
				finishReason === "tool_calls" || hasToolCalls
					? { kind: "tool-calls" }
					: finishReason === "length"
						? { kind: "max-tokens" }
						: { kind: "stop" };
			yield { type: "finish", reason };
		} catch (err) {
			yield* closeOpen();
			const aborted = timeout.aborted || options.signal?.aborted;
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						code: aborted ? "DEVIN_DIRECT_TIMEOUT" : "DEVIN_DIRECT",
						message: err instanceof Error ? err.message : String(err)
					}
				}
			};
		}
	}
}

function apply(ctx, config) {
	ctx.effect(() => {
		const adapter = new DevinDirectAdapter(ctx, config);
		ctx.llm.registerAdapter(["devin-direct"], adapter);
		ctx.llm.registerConfigurableProviders([
			{
				provider: "devin-direct",
				displayName: "Devin Direct (model only)",
				settingsNs: name,
				settingsPath: []
			}
		]);
		return () => {};
	});
}

export { Config, apply, inject, name };
