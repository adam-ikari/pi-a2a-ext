import { AgentRegistry, MAIN_AGENT_ID, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { randomUUID } from "node:crypto";
import { isDenied } from "./config.ts";
import type { BridgeConfig } from "./config.ts";
import type { McpContent, McpTool } from "./server.ts";

/** Convert a ToolInfo schema to JSON Schema; fall back to raw parameters. */
function toInputSchema(parameters: unknown): Record<string, unknown> {
	try {
		return toolWireSchema({ parameters } as never) as Record<string, unknown>;
	} catch {
		return (parameters ?? { type: "object" }) as Record<string, unknown>;
	}
}

/**
 * Build the tools/list catalog. Re-fetches pi.getAllTools() on every call to
 * reflect dynamic tools; schema conversion is cached per tool name.
 */
export function buildToolCatalog(pi: ExtensionAPI, cfg: BridgeConfig): () => Promise<McpTool[]> {
	const schemaCache = new Map<string, Record<string, unknown>>();
	return async () => {
		const out: McpTool[] = [];
		for (const t of pi.getAllTools()) {
			if (isDenied(cfg, t.name)) continue;
			let inputSchema = schemaCache.get(t.name);
			if (inputSchema === undefined) {
				inputSchema = toInputSchema(t.parameters);
				schemaCache.set(t.name, inputSchema);
			}
			out.push({ name: t.name, description: t.description ?? "", inputSchema });
		}
		return out;
	};
}

/**
 * Build the tools/call executor. Resolves the tool through the live Main
 * session registry so the host's built-in approval gate (ExtensionToolWrapper)
 * governs write/exec calls; rejections surface as isError results.
 */
export function buildCallTool(
	extCtx: ExtensionContext,
	cfg: BridgeConfig,
): (name: string, args: unknown) => Promise<{ content: McpContent[]; isError: boolean }> {
	return async (name, args) => {
		if (isDenied(cfg, name)) {
			return { content: [{ type: "text", text: `tool '${name}' is not exposed by this bridge` }], isError: true };
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
			hasQueuedMessages: extCtx.hasPendingMessages,
			abort: extCtx.abort,
			ui: extCtx.ui,
			hasUI: extCtx.hasUI,
			localProtocolOptions: extCtx.localProtocolOptions,
		};
		try {
			const r = await tool.execute(randomUUID(), args as never, undefined, undefined, ctx as never);
			const content = (r.content ?? []).map(b =>
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
}
