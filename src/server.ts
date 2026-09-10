import { randomUUID } from "node:crypto";
import { authorize } from "./auth.ts";
import type { BridgeConfig } from "./config.ts";

export type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface BridgeDeps {
	getTools(): Promise<McpTool[]>;
	callTool(
		name: string,
		args: unknown,
	): Promise<{ content: McpContent[]; isError: boolean }>;
	serverInfo(): { name: string; version: string };
}

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 1 day idle expiry

interface JsonRpcRequest {
	jsonrpc?: string;
	id?: unknown;
	method?: string;
	params?: {
		protocolVersion?: string;
		name?: string;
		arguments?: unknown;
	};
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

export async function startServer(
	cfg: BridgeConfig,
	deps: BridgeDeps,
): Promise<{ port: number; stop(): void }> {
	// mcp-session-id -> last-seen timestamp. Dynamic membership + per-entry
	// timestamps, hence Map.
	const sessions = new Map<string, number>();

	async function handler(req: Request): Promise<Response> {
		try {
			if (req.method === "GET") return new Response(null, { status: 405 });
			if (req.method === "DELETE") {
				const sid = req.headers.get("mcp-session-id");
				if (sid) sessions.delete(sid);
				return new Response(null, { status: 204 });
			}
			if (req.method !== "POST") return new Response(null, { status: 405 });

			if (!authorize({ token: cfg.token }, req.headers)) {
				return json(401, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "unauthorized" } });
			}

			let msg: unknown;
			try {
				msg = await req.json();
			} catch {
				return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
			}
			if (Array.isArray(msg)) {
				return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
			}
			const rpc = msg as JsonRpcRequest;
			if (typeof rpc !== "object" || rpc === null || typeof rpc.method !== "string") {
				return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
			}
			const id = rpc.id;

			// Session check: tolerate a missing header (client notifications may
			// fire before a session id exists); 404 only for an unknown id.
			const sid = req.headers.get("mcp-session-id");
			if (rpc.method !== "initialize" && sid !== null) {
				const ts = sessions.get(sid);
				if (ts === undefined || Date.now() - ts > SESSION_TTL_MS) {
					return json(404, { jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message: "unknown session" } });
				}
			}

			// Notifications: no id, no result.
			if (rpc.method.startsWith("notifications/")) {
				return new Response(null, { status: 202 });
			}

			switch (rpc.method) {
				case "initialize": {
					const newSid = randomUUID();
					sessions.set(newSid, Date.now());
					return json(
						200,
						{
							jsonrpc: "2.0",
							id,
							result: {
								protocolVersion: rpc.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
								capabilities: { tools: {} },
								serverInfo: deps.serverInfo(),
							},
						},
						{ "mcp-session-id": newSid },
					);
				}
				case "ping":
					return json(200, { jsonrpc: "2.0", id, result: {} });
				case "tools/list": {
					const tools = await deps.getTools();
					return json(200, { jsonrpc: "2.0", id, result: { tools } });
				}
				case "tools/call": {
					const name = rpc.params?.name ?? "";
					const args = rpc.params?.arguments;
					try {
						const r = await deps.callTool(name, args);
						return json(200, { jsonrpc: "2.0", id, result: { content: r.content, isError: r.isError } });
					} catch (e) {
						// Tool rejection must not become an HTTP error.
						return json(200, {
							jsonrpc: "2.0",
							id,
							result: {
								content: [{ type: "text", text: String((e as Error)?.message ?? e) }],
								isError: true,
							},
						});
					}
				}
				default:
					return json(200, { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
			}
		} catch (e) {
			return json(500, {
				jsonrpc: "2.0",
				id: null,
				error: { code: -32603, message: `internal error: ${(e as Error)?.message ?? String(e)}` },
			});
		}
	}

	async function serve(port: number) {
		return Bun.serve({
			hostname: cfg.host,
			port,
			maxRequestBodySize: 1024 * 1024,
			fetch: handler,
		});
	}

	let server: Awaited<ReturnType<typeof serve>>;
	try {
		server = await serve(cfg.port);
	} catch (e) {
		// EADDRINUSE on an explicit port: retry once on an ephemeral port.
		if (cfg.port !== 0 && (e as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
			server = await serve(0);
		} else {
			throw e;
		}
	}

	return {
		port: server.port ?? cfg.port,
		stop() {
			server.stop(true);
		},
	};
}
