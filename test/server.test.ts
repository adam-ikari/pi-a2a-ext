/**
 * Protocol tests for startServer with stubbed BridgeDeps: JSON-RPC behavior,
 * auth placement, session enforcement (missing/stale/expired id), version
 * negotiation, and session-map bounds. Real-host behavior is test/smoke.ts.
 */
import { describe, expect, test } from "bun:test";
import { MAX_SESSIONS, SESSION_TTL_MS, startServer } from "../src/server.ts";
import type { BridgeDeps } from "../src/server.ts";

const JSON_HDR = { "content-type": "application/json" };
const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

// Injectable clock: lets TTL tests move time without sleeping.
let clock = Date.now();

function makeDeps(): BridgeDeps {
	return {
		async getTools() {
			return [
				{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
				{ name: "echo", description: "Echo args back", inputSchema: { type: "object" } },
				{ name: "boom", description: "Always throws", inputSchema: { type: "object" } },
			];
		},
		async callTool(name, args) {
			if (name === "boom") throw new Error("kaboom");
			return { content: [{ type: "text", text: `${name} saw ${JSON.stringify(args)}` }], isError: false };
		},
		serverInfo: () => ({ name: "stub-server", version: "9.9.9" }),
		now: () => clock,
	};
}

async function post(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(base, {
		method: "POST",
		headers: { ...JSON_HDR, ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

async function init(base: string, params: Record<string, unknown> = {}): Promise<string> {
	const res = await post(base, { jsonrpc: "2.0", id: 0, method: "initialize", params }, AUTH);
	if (res.status !== 200) throw new Error(`initialize failed with HTTP ${res.status}`);
	const sid = res.headers.get("mcp-session-id");
	if (!sid) throw new Error("initialize response missing Mcp-Session-Id");
	return sid;
}

/** Run `fn` against a fresh server so session-map tests cannot cross-contaminate. */
async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
	const s = await startServer(
		{ port: 0, host: "127.0.0.1", token: TOKEN, deny: [], denyMCPTools: false },
		makeDeps(),
	);
	try {
		await fn(`http://127.0.0.1:${s.port}/`);
	} finally {
		s.stop();
	}
}

describe("server protocol", () => {
	test("no Authorization -> 401", async () => {
		await withServer(async base => {
			const res = await post(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
			expect(res.status).toBe(401);
		});
	});

	test("wrong token -> 401", async () => {
		await withServer(async base => {
			const res = await post(
				base,
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
				{ authorization: "Bearer wrong-token" },
			);
			expect(res.status).toBe(401);
		});
	});

	test("unauthenticated DELETE -> 401 (auth precedes state changes)", async () => {
		await withServer(async base => {
			const sid = await init(base);
			const res = await fetch(base, { method: "DELETE", headers: { "mcp-session-id": sid } });
			expect(res.status).toBe(401);
			// Session must survive the attempt.
			const ping = await post(base, { jsonrpc: "2.0", id: 2, method: "ping" }, { ...AUTH, "mcp-session-id": sid });
			expect(ping.status).toBe(200);
		});
	});

	test("initialize -> 200 with fixed protocolVersion and session id", async () => {
		await withServer(async base => {
			const res = await post(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, AUTH);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
			expect(body.result.protocolVersion).toBe("2025-11-25");
			expect(body.result.serverInfo.name).toBe("stub-server");
			expect(res.headers.get("mcp-session-id")).not.toBeNull();
		});
	});

	test("initialize with unsupported protocolVersion -> server version wins", async () => {
		await withServer(async base => {
			const res = await post(
				base,
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
				AUTH,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { result: { protocolVersion: string } };
			expect(body.result.protocolVersion).toBe("2025-11-25");
		});
	});

	test("non-initialize request without session id -> 400", async () => {
		await withServer(async base => {
			const res = await post(base, { jsonrpc: "2.0", id: 1, method: "tools/list" }, AUTH);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: number; message: string } };
			expect(body.error.message).toContain("missing mcp-session-id");
		});
	});

	test("notification without session id -> 400 (no bypass via header omission)", async () => {
		await withServer(async base => {
			const res = await post(base, { jsonrpc: "2.0", method: "notifications/initialized" }, AUTH);
			expect(res.status).toBe(400);
		});
	});

	test("notification with session id -> 202", async () => {
		await withServer(async base => {
			const sid = await init(base);
			const res = await post(
				base,
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				{ ...AUTH, "mcp-session-id": sid },
			);
			expect(res.status).toBe(202);
		});
	});

	test("unknown session id -> 404", async () => {
		await withServer(async base => {
			const res = await post(
				base,
				{ jsonrpc: "2.0", id: 5, method: "ping" },
				{ ...AUTH, "mcp-session-id": "bogus-session" },
			);
			expect(res.status).toBe(404);
		});
	});

	test("idle TTL: activity refreshes the clock, expiry purges", async () => {
		await withServer(async base => {
			const start = clock;
			const sid = await init(base);

			// Just under the TTL: still alive.
			clock = start + SESSION_TTL_MS - 1000;
			let res = await post(base, { jsonrpc: "2.0", id: 2, method: "ping" }, { ...AUTH, "mcp-session-id": sid });
			expect(res.status).toBe(200);

			// Another full TTL minus 1s since the *refresh*: alive only because
			// the ping above moved last-seen (wall-clock age is now > TTL).
			clock = start + 2 * SESSION_TTL_MS - 2000;
			res = await post(base, { jsonrpc: "2.0", id: 3, method: "ping" }, { ...AUTH, "mcp-session-id": sid });
			expect(res.status).toBe(200);

			// A full TTL plus margin since the *last* activity: expired.
			clock += SESSION_TTL_MS + 1000;
			res = await post(base, { jsonrpc: "2.0", id: 4, method: "ping" }, { ...AUTH, "mcp-session-id": sid });
			expect(res.status).toBe(404);
			clock = start;
		});
	});

	test("authenticated DELETE -> 204 and the session is gone", async () => {
		await withServer(async base => {
			const sid = await init(base);
			const del = await fetch(base, { method: "DELETE", headers: { ...AUTH, "mcp-session-id": sid } });
			expect(del.status).toBe(204);
			const res = await post(base, { jsonrpc: "2.0", id: 2, method: "ping" }, { ...AUTH, "mcp-session-id": sid });
			expect(res.status).toBe(404);
		});
	});

	test("session map is bounded: oldest evicted past MAX_SESSIONS", async () => {
		await withServer(async base => {
			const sids: string[] = [];
			for (let i = 0; i < MAX_SESSIONS + 5; i++) sids.push(await init(base));

			const oldest = await post(base, { jsonrpc: "2.0", id: 2, method: "ping" }, { ...AUTH, "mcp-session-id": sids[0] });
			expect(oldest.status).toBe(404);
			const newest = await post(
				base,
				{ jsonrpc: "2.0", id: 3, method: "ping" },
				{ ...AUTH, "mcp-session-id": sids[sids.length - 1] },
			);
			expect(newest.status).toBe(200);
		});
	});

	test("tools/list -> catalog, no nextCursor", async () => {
		await withServer(async base => {
			const sid = await init(base);
			const res = await post(base, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { ...AUTH, "mcp-session-id": sid });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { result: { tools: unknown[]; nextCursor?: unknown } };
			expect(body.result.tools.length).toBe(3);
			expect("nextCursor" in body.result).toBe(false);
		});
	});

	test("tools/call echo roundtrip", async () => {
		await withServer(async base => {
			const sid = await init(base);
			const res = await post(
				base,
				{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { x: 1 } } },
				{ ...AUTH, "mcp-session-id": sid },
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				result: { content: Array<{ type: string; text: string }>; isError: boolean };
			};
			expect(body.result.isError).toBe(false);
			expect(body.result.content[0]?.text).toContain(`echo saw {"x":1}`);
		});
	});

	test("throwing tool -> isError result, still HTTP 200", async () => {
		await withServer(async base => {
			const sid = await init(base);
			const res = await post(
				base,
				{ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom", arguments: {} } },
				{ ...AUTH, "mcp-session-id": sid },
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError: boolean } };
			expect(body.result.isError).toBe(true);
			expect(body.result.content[0]?.text).toContain("kaboom");
		});
	});

	test("unknown method -> -32601", async () => {
		await withServer(async base => {
			const sid = await init(base);
			const res = await post(base, { jsonrpc: "2.0", id: 6, method: "foo" }, { ...AUTH, "mcp-session-id": sid });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { error?: { code: number } };
			expect(body.error?.code).toBe(-32601);
		});
	});

	test("GET -> 405", async () => {
		await withServer(async base => {
			const res = await fetch(base);
			expect(res.status).toBe(405);
		});
	});

	test("invalid JSON body -> 400 parse error", async () => {
		await withServer(async base => {
			const res = await post(base, "{not json", AUTH);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error?: { code: number } };
			expect(body.error?.code).toBe(-32700);
		});
	});

	test("missing/wrong jsonrpc field -> 400 invalid request", async () => {
		await withServer(async base => {
			let res = await post(base, { id: 1, method: "ping" }, AUTH);
			expect(res.status).toBe(400);
			res = await post(base, { jsonrpc: "1.0", id: 1, method: "ping" }, AUTH);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error?: { code: number } };
			expect(body.error?.code).toBe(-32600);
		});
	});

	test("batch request -> 400 invalid request", async () => {
		await withServer(async base => {
			const res = await post(base, [{ jsonrpc: "2.0", id: 1, method: "ping" }], AUTH);
			expect(res.status).toBe(400);
		});
	});
});
