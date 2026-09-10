/**
 * Temporary verification script for the W2 server/bridge contract.
 * Runs a stubbed BridgeDeps against the real startServer and asserts the
 * client-visible protocol behavior. Prints "W2 OK" when all checks pass.
 */
import { startServer } from "../src/server.ts";
import type { BridgeDeps } from "../src/server.ts";

const deps: BridgeDeps = {
	async getTools() {
		return [
			{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
			{ name: "echo", description: "Echo args back", inputSchema: { type: "object" } },
		];
	},
	async callTool(name, args) {
		return { content: [{ type: "text", text: `${name} saw ${JSON.stringify(args)}` }], isError: false };
	},
	serverInfo() {
		return { name: "stub-server", version: "9.9.9" };
	},
};

const { port, stop } = await startServer({ port: 0, host: "127.0.0.1", token: "t", deny: [], denyMCPTools: false }, deps);
const base = `http://127.0.0.1:${port}/`;
const json = { "content-type": "application/json" };

function assert(cond: unknown, label: string): void {
	if (!cond) {
		console.error(`FAIL: ${label}`);
		process.exit(1);
	}
	console.log(`ok: ${label}`);
}

// 1. no Authorization -> 401
let res = await fetch(base, { method: "POST", headers: json, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
assert(res.status === 401, "no auth -> 401");

// 2. initialize with token -> 200 + protocolVersion + Mcp-Session-Id header
res = await fetch(base, { method: "POST", headers: { ...json, authorization: "Bearer t" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
assert(res.status === 200, "initialize -> 200");
const init = (await res.json()) as { result: { protocolVersion: string } };
assert(init.result.protocolVersion === "2025-11-25", "protocolVersion default 2025-11-25");
const sid = res.headers.get("mcp-session-id");
assert(sid !== null, "Mcp-Session-Id header present");

// 3. notifications/initialized with session -> 202
res = await fetch(base, { method: "POST", headers: { ...json, authorization: "Bearer t", "mcp-session-id": sid! }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
assert(res.status === 202, "notification -> 202");

// 4. tools/list -> 2 tools
res = await fetch(base, { method: "POST", headers: { ...json, authorization: "Bearer t", "mcp-session-id": sid! }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
assert(res.status === 200, "tools/list -> 200");
const list = (await res.json()) as { result: { tools: unknown[] } };
assert(list.result.tools.length === 2, "tools/list length 2");
assert("nextCursor" in list.result === false, "no nextCursor");

// 5. tools/call echo
res = await fetch(base, { method: "POST", headers: { ...json, authorization: "Bearer t", "mcp-session-id": sid! }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { x: 1 } } }) });
assert(res.status === 200, "tools/call -> 200");
const call = (await res.json()) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };
assert(call.result.isError === false, "tools/call isError false");
assert(call.result.content[0]?.text.includes(`echo saw {"x":1}`), "tools/call echo roundtrip");

// 6. unknown method -> -32601
res = await fetch(base, { method: "POST", headers: { ...json, authorization: "Bearer t", "mcp-session-id": sid! }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "resources/list" }) });
assert(res.status === 200, "unknown method -> 200");
const unk = (await res.json()) as { error?: { code: number } };
assert(unk.error?.code === -32601, "unknown method -> -32601");

// 7. GET -> 405
res = await fetch(base);
assert(res.status === 405, "GET -> 405");

// 8. POST with unknown session id -> 404
res = await fetch(base, { method: "POST", headers: { ...json, authorization: "Bearer t", "mcp-session-id": "bogus-session" }, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }) });
assert(res.status === 404, "unknown session -> 404");

stop();
console.log("W2 OK");