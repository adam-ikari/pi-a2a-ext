import { randomUUID } from "node:crypto";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { AgentRegistry, type ExtensionAPI, type ExtensionContext, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent";
// Loads pi-coding-agent's AgentToolContext augmentation (CustomToolContext
// fields + ui/hasUI) so the execute() context literal is fully type-checked
// instead of relying on the all-optional base declaration.
import type {} from "@oh-my-pi/pi-coding-agent/tools/context";
import { auditDone, auditStart } from "./audit.ts";
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
 * Build the tools/list catalog: the host session's registry, verbatim.
 *
 * No filtering. `pi.getAllTools()` is the whole registered set, including
 * `hidden` tools and tools the host currently has disabled for its own model —
 * the bridge does not second-guess that. Execution goes through the host's own
 * tools (see buildCallTool), so the host's permission model decides what
 * actually happens to a call.
 *
 * Re-fetched on every call so dynamic tools show up; schema conversion is cached
 * per `parameters` object identity (WeakMap), so a tool that re-registers with a
 * new schema object is re-converted instead of serving a stale cached schema.
 */
export function buildToolCatalog(pi: ExtensionAPI): () => Promise<McpTool[]> {
	const schemaCache = new WeakMap<object, Record<string, unknown>>();
	return async () => {
		const out: McpTool[] = [];
		for (const t of pi.getAllTools()) {
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
 * Build the tools/call executor: resolve the name against the same registry
 * tools/list advertises, then hand it to the host's tool implementation.
 *
 * Nothing outside the registry is reachable, so aliases (e.g. `xd://bash`) and
 * names that are not registered are rejected. Host execution resolves through
 * the live Main session so the host's built-in approval gate
 * (ExtensionToolWrapper) governs write/exec calls; rejections surface as
 * isError results.
 */
export function buildCallTool(
	pi: ExtensionAPI,
	extCtx: ExtensionContext,
): (name: string, args: unknown, sid?: string | null) => Promise<{ content: McpContent[]; isError: boolean }> {
	const runHost = async (name: string, args: unknown): Promise<{ content: McpContent[]; isError: boolean }> => {
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
		// Mirror the host's own tool events so the controlled TUI renders each
		// remote call exactly like a local one (same card, same lifecycle). These
		// events drive rendering only — unlike message_end they never touch the
		// message stream, so the remote call cannot perturb the LLM context.
		const toolCallId = randomUUID();
		session.agent.emitExternalEvent({ type: "tool_execution_start", toolCallId, toolName: name, args });
		try {
			const r = await tool.execute(toolCallId, args, undefined, undefined, ctx);
			session.agent.emitExternalEvent({
				type: "tool_execution_end",
				toolCallId,
				toolName: name,
				result: r,
				isError: !!r.isError,
			});
			const content = (r.content ?? []).map((b) =>
				b?.type === "text"
					? { type: "text" as const, text: b.text }
					: b?.type === "image"
						? { type: "image" as const, data: b.data, mimeType: b.mimeType }
						: { type: "text" as const, text: JSON.stringify(b) },
			);
			return { content, isError: !!r.isError };
		} catch (e) {
			const message = (e as Error)?.message ?? String(e);
			session.agent.emitExternalEvent({
				type: "tool_execution_end",
				toolCallId,
				toolName: name,
				result: { content: [{ type: "text", text: message }], isError: true },
				isError: true,
			});
			return { content: [{ type: "text", text: message }], isError: true };
		}
	};

	const run = async (name: string, args: unknown): Promise<{ content: McpContent[]; isError: boolean }> => {
		// One message for "not registered" and "not in catalog": a caller holding
		// the token learns nothing about which names exist behind the curtain.
		if (!pi.getAllTools().some((t) => t.name === name)) {
			return { content: [{ type: "text", text: `tool '${name}' is not exposed by this bridge` }], isError: true };
		}
		return runHost(name, args);
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
