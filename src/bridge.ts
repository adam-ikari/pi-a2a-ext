import { randomUUID } from "node:crypto";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { AgentRegistry, type ExtensionAPI, type ExtensionContext, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent";
// Loads pi-coding-agent's AgentToolContext augmentation (CustomToolContext
// fields + ui/hasUI) so the execute() context literal is fully type-checked
// instead of relying on the all-optional base declaration.
import type {} from "@oh-my-pi/pi-coding-agent/tools/context";
import { auditDone, auditStart } from "./audit.ts";
import type { BridgeConfig } from "./config.ts";
import { isDenied } from "./config.ts";
import type { McpContent, McpTool } from "./server.ts";

/** Convert a ToolInfo schema to JSON Schema; fall back to raw parameters. */
function toInputSchema(parameters: TSchema): Record<string, unknown> {
	try {
		// toolWireSchema reads only `.parameters`; name/description are unused
		// filler because the pi-ai Tool type requires them.
		return toolWireSchema({ name: "", description: "", parameters });
	} catch {
		return (parameters ?? { type: "object" }) as Record<string, unknown>;
	}
}

/**
 * Build the tools/list catalog. Re-fetches pi.getAllTools() on every call to
 * reflect dynamic tools; schema conversion is cached per `parameters` object
 * identity (WeakMap), so a tool that re-registers with a new schema object is
 * re-converted instead of serving a stale cached schema.
 */
export function buildToolCatalog(pi: ExtensionAPI, cfg: BridgeConfig): () => Promise<McpTool[]> {
	const schemaCache = new WeakMap<object, Record<string, unknown>>();
	return async () => {
		const out: McpTool[] = [];
		for (const t of pi.getAllTools()) {
			if (isDenied(cfg, t.name)) continue;
			const params = t.parameters;
			const key = typeof params === "object" && params !== null ? params : null;
			let inputSchema = key ? schemaCache.get(key) : undefined;
			if (inputSchema === undefined) {
				inputSchema = toInputSchema(params);
				if (key) schemaCache.set(key, inputSchema);
			}
			out.push({ name: t.name, description: t.description ?? "", inputSchema });
		}
		return out;
	};
}

/**
 * Build the tools/call executor.
 *
 * Exposure = intersection: the name must survive `deny` filtering AND appear
 * in pi.getAllTools() (the same source tools/list advertises). The catalog is
 * the full session registry — including `hidden` tools and tools the host
 * currently has disabled — but nothing outside it is reachable, so aliases
 * (e.g. `xd://bash`) and guessable hidden names are rejected here.
 *
 * Execution resolves through the live Main session registry so the host's
 * built-in approval gate (ExtensionToolWrapper) governs write/exec calls;
 * rejections surface as isError results.
 */
export function buildCallTool(
	pi: ExtensionAPI,
	extCtx: ExtensionContext,
	cfg: BridgeConfig,
): (name: string, args: unknown, sid?: string | null) => Promise<{ content: McpContent[]; isError: boolean }> {
	const run = async (name: string, args: unknown): Promise<{ content: McpContent[]; isError: boolean }> => {
		// One message for "denied" and "not in catalog": a caller holding the
		// token learns nothing about which names exist behind the curtain.
		const notExposed = `tool '${name}' is not exposed by this bridge`;
		if (isDenied(cfg, name)) return { content: [{ type: "text", text: notExposed }], isError: true };
		if (!pi.getAllTools().some((t) => t.name === name)) {
			return { content: [{ type: "text", text: notExposed }], isError: true };
		}
		const ref = AgentRegistry.global().get(MAIN_AGENT_ID);
		if (!ref?.session) {
			return { content: [{ type: "text", text: "main session not available" }], isError: true };
		}
		const session = ref.session;
		const tool = session.getToolByName(name);
		if (!tool) {
			return { content: [{ type: "text", text: `unknown tool '${name}'` }], isError: true };
		}
		const ctx = {
			sessionManager: session.sessionManager,
			modelRegistry: session.modelRegistry,
			model: session.model,
			settings: session.settings,
			isIdle: extCtx.isIdle,
			abort: extCtx.abort,
			hasQueuedMessages: extCtx.hasPendingMessages,
			ui: extCtx.ui,
			hasUI: extCtx.hasUI,
			localProtocolOptions: extCtx.localProtocolOptions,
		};
		try {
			const r = await tool.execute(randomUUID(), args, undefined, undefined, ctx);
			const content = (r.content ?? []).map((b) =>
				b?.type === "text"
					? { type: "text" as const, text: b.text }
					: b?.type === "image"
						? { type: "image" as const, data: b.data, mimeType: b.mimeType }
						: { type: "text" as const, text: JSON.stringify(b) },
			);
			return { content, isError: !!r.isError };
		} catch (e) {
			return { content: [{ type: "text", text: (e as Error)?.message ?? String(e) }], isError: true };
		}
	};

	return async (name, args, sid) => {
		// Dispatch-time record: if the call never settles (host approval
		// waiting for a UI that does not exist), the start line is the trace.
		const id = randomUUID();
		auditStart(id, sid ?? null, name, args);
		let r: { content: McpContent[]; isError: boolean };
		try {
			r = await run(name, args);
		} catch (e) {
			r = { content: [{ type: "text", text: (e as Error)?.message ?? String(e) }], isError: true };
		}
		auditDone(id, sid ?? null, name, args, r.isError);
		return r;
	};
}
