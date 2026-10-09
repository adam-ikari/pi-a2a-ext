/**
 * Protocol tests for startServer with stubbed BridgeDeps: JSON-RPC behavior,
 * auth placement, session enforcement (missing/stale/expired id), version
 * negotiation, and session-map bounds. Real-host behavior is test/smoke.ts.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { connect } from "node:net";
import type { BridgeDeps } from "../src/server.ts";
import { MAX_SESSIONS, SESSION_TTL_MS, startServer } from "../src/server.ts";

const JSON_HDR = { "content-type": "application/json" };
const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

/** Open a socket the server cannot hand to its request pool, to read the listener alone. */
function canConnect(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = connect(port, "127.0.0.1");
		sock.once("connect", () => {
			sock.destroy();
			resolve(true);
		});
		sock.once("error", () => resolve(false));
	});
}

// Injectable clock: lets TTL tests move time without sleeping.
let clock = Date.now();

function makeDeps(): BridgeDeps {
	return {
		async getTools() {
			return [
				{
					name: "read",
					description: "Read a file",
					inputSchema: { type: "object", properties: { path: { type: "string" } } },
				},
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
		{
			port: 0,
			host: "127.0.0.1",
			token: TOKEN,
		},
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
		await withServer(async (base) => {
			const res = await post(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
			expect(res.status).toBe(401);
		});
	});

	test("wrong token -> 401", async () => {
		await withServer(async (base) => {
			const res = await post(
				base,
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
				{ authorization: "Bearer wrong-token" },
			);
			expect(res.status).toBe(401);
		});
	});

	test("unauthenticated DELETE -> 401 (auth precedes state changes)", async () => {
		await withServer(async (base) => {
			const sid = await init(base);
			const res = await fetch(base, { method: "DELETE", headers: { "mcp-session-id": sid } });
			expect(res.status).toBe(401);
			// Session must survive the attempt.
			const ping = await post(base, { jsonrpc: "2.0", id: 2, method: "ping" }, { ...AUTH, "mcp-session-id": sid });
			expect(ping.status).toBe(200);
		});
	});

	test("initialize -> 200 with fixed protocolVersion and session id", async () => {
		await withServer(async (base) => {
			const res = await post(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, AUTH);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
			expect(body.result.protocolVersion).toBe("2025-11-25");
			expect(body.result.serverInfo.name).toBe("stub-server");
			expect(res.headers.get("mcp-session-id")).not.toBeNull();
		});
	});

	test("initialize with unsupported protocolVersion -> server version wins", async () => {
		await withServer(async (base) => {
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
		await withServer(async (base) => {
			const res = await post(base, { jsonrpc: "2.0", id: 1, method: "tools/list" }, AUTH);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: number; message: string } };
			expect(body.error.message).toContain("missing mcp-session-id");
		});
	});

	test("notification without session id -> 400 (no bypass via header omission)", async () => {
		await withServer(async (base) => {
			const res = await post(base, { jsonrpc: "2.0", method: "notifications/initialized" }, AUTH);
			expect(res.status).toBe(400);
		});
	});

	test("notification with session id -> 202", async () => {
		await withServer(async (base) => {
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
		await withServer(async (base) => {
			const res = await post(
				base,
				{ jsonrpc: "2.0", id: 5, method: "ping" },
				{ ...AUTH, "mcp-session-id": "bogus-session" },
			);
			expect(res.status).toBe(404);
		});
	});

	test("idle TTL: activity refreshes the clock, expiry purges", async () => {
		await withServer(async (base) => {
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
		await withServer(async (base) => {
			const sid = await init(base);
			const del = await fetch(base, { method: "DELETE", headers: { ...AUTH, "mcp-session-id": sid } });
			expect(del.status).toBe(204);
			const res = await post(base, { jsonrpc: "2.0", id: 2, method: "ping" }, { ...AUTH, "mcp-session-id": sid });
			expect(res.status).toBe(404);
		});
	});

	test("session map is bounded: oldest evicted past MAX_SESSIONS", async () => {
		await withServer(async (base) => {
			const sids: string[] = [];
			for (let i = 0; i < MAX_SESSIONS + 5; i++) sids.push(await init(base));

			const oldest = await post(
				base,
				{ jsonrpc: "2.0", id: 2, method: "ping" },
				{ ...AUTH, "mcp-session-id": sids[0] },
			);
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
		await withServer(async (base) => {
			const sid = await init(base);
			const res = await post(base, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { ...AUTH, "mcp-session-id": sid });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { result: { tools: unknown[]; nextCursor?: unknown } };
			expect(body.result.tools.length).toBe(3);
			expect("nextCursor" in body.result).toBe(false);
		});
	});

	test("tools/call echo roundtrip", async () => {
		await withServer(async (base) => {
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
		await withServer(async (base) => {
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
		await withServer(async (base) => {
			const sid = await init(base);
			const res = await post(base, { jsonrpc: "2.0", id: 6, method: "foo" }, { ...AUTH, "mcp-session-id": sid });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { error?: { code: number } };
			expect(body.error?.code).toBe(-32601);
		});
	});

	test("GET -> 405", async () => {
		await withServer(async (base) => {
			const res = await fetch(base);
			expect(res.status).toBe(405);
		});
	});

	test("invalid JSON body -> 400 parse error", async () => {
		await withServer(async (base) => {
			const res = await post(base, "{not json", AUTH);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error?: { code: number } };
			expect(body.error?.code).toBe(-32700);
		});
	});

	test("missing/wrong jsonrpc field -> 400 invalid request", async () => {
		await withServer(async (base) => {
			let res = await post(base, { id: 1, method: "ping" }, AUTH);
			expect(res.status).toBe(400);
			res = await post(base, { jsonrpc: "1.0", id: 1, method: "ping" }, AUTH);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error?: { code: number } };
			expect(body.error?.code).toBe(-32600);
		});
	});

	test("batch request -> 400 invalid request", async () => {
		await withServer(async (base) => {
			const res = await post(base, [{ jsonrpc: "2.0", id: 1, method: "ping" }], AUTH);
			expect(res.status).toBe(400);
		});
	});
});

describe("server internal errors", () => {
	test("a failure inside the handler is a leak-free 500, and the detail goes to the log", async () => {
		// The 500 branch promises: "Details (host paths, stack) go to the server log
		// only". Nothing checked either half of that until now.
		const leaked = new Error("ENOENT: /home/dev/.omp/agent/private.log");
		const logged: unknown[][] = [];
		const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			logged.push(a);
		});
		const s = await startServer(
			{ port: 0, host: "127.0.0.1", token: TOKEN },
			{
				...makeDeps(),
				async getTools() {
					throw leaked;
				},
			},
		);
		try {
			const base = `http://127.0.0.1:${s.port}/`;
			const sid = await init(base);
			const res = await post(base, { jsonrpc: "2.0", id: 7, method: "tools/list" }, { ...AUTH, "mcp-session-id": sid });
			expect(res.status).toBe(500);
			const text = await res.text();
			expect(text).toContain("internal error");
			expect(text).not.toContain("/home/dev");
			expect(text).not.toContain("ENOENT");
			expect(String(logged[0]?.[0])).toContain("internal error");
			expect(logged.some((a) => a.includes(leaked))).toBe(true);
		} finally {
			spy.mockRestore();
			s.stop();
		}
	});

	test("explicit port already taken -> binds an ephemeral one and flags it", async () => {
		// The branch only exists for a non-zero configured port, and every other test
		// here starts on port 0 — so the fallback and the warning the extension prints
		// from `fellBack` had no coverage.
		const squatter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("taken") });
		const wanted = squatter.port as number;
		const s = await startServer({ port: wanted, host: "127.0.0.1", token: TOKEN }, makeDeps());
		try {
			expect(s.fellBack).toBe(true);
			expect(s.port).not.toBe(wanted);
			// And the server that came back is the usable one.
			const base = `http://127.0.0.1:${s.port}/`;
			const sid = await init(base);
			const res = await post(base, { jsonrpc: "2.0", id: 1, method: "ping" }, { ...AUTH, "mcp-session-id": sid });
			expect(res.status).toBe(200);
		} finally {
			s.stop();
			squatter.stop(true);
		}
	});

	test("only a port conflict gets the ephemeral retry", async () => {
		// The retry is keyed on EADDRINUSE for a reason: falling back on any bind
		// failure would turn a misconfiguration into a silent port change. EACCES on a
		// privileged port is what separates the two behaviours, since an ephemeral port
		// would bind fine there — the bridge has to surface it instead of retrying.
		let privileged = false;
		try {
			const probe = Bun.serve({ hostname: "127.0.0.1", port: 1, fetch: () => new Response() });
			probe.stop(true);
		} catch (e) {
			privileged = (e as NodeJS.ErrnoException).code === "EACCES";
		}
		if (!privileged) return; // this user may bind low ports, so there is nothing to check
		await expect(startServer({ port: 1, host: "127.0.0.1", token: TOKEN }, makeDeps())).rejects.toThrow(
			/permission denied/,
		);
	});
});

describe("releasing the port", () => {
	test("a call already in flight still answers; new connections are refused", async () => {
		// Main going away releases the port, and a tools/call can be mid-flight at that
		// exact moment. A forced stop severs it: the client gets a socket reset and the
		// audit loses the `done` half of a call that the host already paid for. The
		// reading this pins is the asymmetry Bun gives without `force` — no new
		// connections, but the one in flight gets to finish and be recorded.
		const deps = makeDeps();
		let entered = false;
		const s = await startServer(
			{ port: 0, host: "127.0.0.1", token: TOKEN },
			{
				...deps,
				async callTool(name, args, sid) {
					entered = true;
					await new Promise((r) => setTimeout(r, 300));
					return deps.callTool(name, args, sid);
				},
			},
		);
		const base = `http://127.0.0.1:${s.port}/`;
		expect(await canConnect(s.port)).toBe(true); // the reading below has to be capable of true
		const sid = await init(base);
		const hdr = { ...AUTH, "mcp-session-id": sid };
		const inFlight = post(
			base,
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { n: 1 } } },
			hdr,
		);
		for (let waited = 0; !entered; waited += 10) {
			if (waited > 5_000) throw new Error("callTool never ran");
			await new Promise((r) => setTimeout(r, 10));
		}
		s.stop();
		const res = await inFlight;
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result?: { content?: [{ text?: string }] } };
		expect(body.result?.content?.[0]?.text).toContain("echo saw");
		// The listener is gone for anyone who has to open a connection. Measured with a
		// raw connect on purpose: Bun 1.3.14 does NOT close a socket that was already
		// open when the stop happened, so a fetch from the same client pool still gets
		// served (its `closeIdleConnections()` returns undefined and changes nothing).
		// That lingering half is a Bun gap, not something to assert in favour of — the
		// reading that matters here is that nothing new can attach.
		expect(await canConnect(s.port)).toBe(false);
	});
});
