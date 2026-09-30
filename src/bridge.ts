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
import { FileOpError } from "./fileguard.ts";
import type { BridgeTool } from "./filetools.ts";
import type { McpContent, McpTool } from "./server.ts";

/**
 * The bridge's own tools live in a reserved namespace. If a host tool ever
 * takes the same name, the host wins (its calls keep going through the host's
 * approval gate) and we warn once instead of silently shadowing.
 */
function bridgeOnly(bridgeTools: BridgeTool[], hostNames: Set<string>, warn: (name: string) => void): BridgeTool[] {
	return bridgeTools.filter((t) => {
		if (hostNames.has(t.name)) {
			warn(t.name);
			return false;
		}
		return true;
	});
}

function makeWarner(): (name: string) => void {
	const seen = new Set<string>();
	return (name) => {
		if (seen.has(name)) return;
		seen.add(name);
		console.error(`[a2a-bridge] host tool '${name}' shadows the bridge's own tool of that name`);
	};
}

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
export function buildToolCatalog(
	pi: ExtensionAPI,
	cfg: BridgeConfig,
	bridgeTools: BridgeTool[] = [],
): () => Promise<McpTool[]> {
	const schemaCache = new WeakMap<object, Record<string, unknown>>();
	const warn = makeWarner();
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
		for (const t of bridgeOnly(bridgeTools, new Set(out.map((x) => x.name)), warn)) {
			if (isDenied(cfg, t.name)) continue;
			out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
		}
		return out;
	};
}

/**
 * Build the tools/call executor.
 *
 * Exposure = intersection: the name must survive `deny` filtering AND appear
 * either in pi.getAllTools() (the same source tools/list advertises) or in the
 * bridge's own tool table. The host catalog is the full session registry —
 * including `hidden` tools and tools the host currently has disabled — but
 * nothing outside it is reachable, so aliases (e.g. `xd://bash`) and guessable
 * hidden names are rejected here. On a name collision the host wins: bridge
 * tools bypass the host's approval gate, so shadowing them must not be possible.
 *
 * Host execution resolves through the live Main session registry so the host's
 * built-in approval gate (ExtensionToolWrapper) governs write/exec calls;
 * rejections surface as isError results.
 */
export function buildCallTool(
	pi: ExtensionAPI,
	extCtx: ExtensionContext,
	cfg: BridgeConfig,
	bridgeTools: BridgeTool[] = [],
): (name: string, args: unknown, sid?: string | null) => Promise<{ content: McpContent[]; isError: boolean }> {
	const warn = makeWarner();

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

	const run = async (
		name: string,
		args: unknown,
		sid: string | null,
	): Promise<{ content: McpContent[]; isError: boolean }> => {
		// One message for "denied" and "not in catalog": a caller holding the
		// token learns nothing about which names exist behind the curtain.
		const notExposed = `tool '${name}' is not exposed by this bridge`;
		if (isDenied(cfg, name)) return { content: [{ type: "text", text: notExposed }], isError: true };
		const hostNames = new Set(pi.getAllTools().map((t) => t.name));
		if (hostNames.has(name)) return runHost(name, args);
		const bridge = bridgeOnly(bridgeTools, hostNames, warn).find((t) => t.name === name);
		if (!bridge) return { content: [{ type: "text", text: notExposed }], isError: true };
		try {
			return await bridge.execute(args, sid);
		} catch (e) {
			if (e instanceof FileOpError) {
				return { content: [{ type: "text", text: `a2a_file_error ${e.code}: ${e.message}` }], isError: true };
			}
			return { content: [{ type: "text", text: (e as Error)?.message ?? String(e) }], isError: true };
		}
	};

	return async (name, args, sid) => {
		const bridge = bridgeTools.find((t) => t.name === name);
		const audited =
			bridge?.auditView && typeof args === "object" && args !== null
				? bridge.auditView(args as Record<string, unknown>)
				: args;
		// Chunk lines would bury the log; the transfer is bracketed by
		// start/end records that carry the path and final size.
		const skip = bridge?.skipAudit?.(name, args) ?? false;
		const id = randomUUID();
		// Dispatch-time record: if the call never settles (host approval
		// waiting for a UI that does not exist), the start line is the trace.
		if (!skip) auditStart(id, sid ?? null, name, audited);
		let r: { content: McpContent[]; isError: boolean };
		try {
			r = await run(name, args, sid ?? null);
		} catch (e) {
			r = { content: [{ type: "text", text: (e as Error)?.message ?? String(e) }], isError: true };
		}
		if (!skip) auditDone(id, sid ?? null, name, audited, r.isError);
		return r;
	};
}
