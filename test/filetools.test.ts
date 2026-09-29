import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "../src/config.ts";
import { buildFileTools } from "../src/filetools.ts";
import type { McpContent } from "../src/server.ts";

let dir: string;
let clock: { t: number };

function makeCfg(over: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		port: 0,
		token: "t",
		host: "127.0.0.1",
		deny: [],
		denyMCPTools: false,
		fileRoot: join(dir, "root"),
		maxFileBytes: 4096,
		...over,
	};
}

type Result = { content: McpContent[]; isError: boolean };

function payload(r: Result): Record<string, unknown> {
	return JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;
}

function errText(r: Result): string {
	return (r.content[0] as { text: string }).text;
}

function tools(over: Partial<BridgeConfig> = {}) {
	const built = buildFileTools(makeCfg(over), { now: () => clock.t });
	const byName = new Map(built.tools.map((t) => [t.name, t]));
	return {
		byName,
		async call(name: string, args: unknown, sid: string | null = "s1"): Promise<Result> {
			const t = byName.get(name);
			if (!t) throw new Error(`no such tool: ${name}`);
			return t.execute(args, sid);
		},
	};
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

async function exists(p: string): Promise<boolean> {
	try {
		await lstat(p);
		return true;
	} catch {
		return false;
	}
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "a2a-files-"));
});

beforeEach(() => {
	clock = { t: 1_000_000 };
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("a2a_file_put / a2a_file_get", () => {
	test("round-trips bytes and reports sha256", async () => {
		const api = tools();
		const put = await api.call("a2a_file_put", { path: "notes/hello.txt", file: { bytes: b64("hello a2a") } });
		expect(put.isError).toBe(false);
		expect(payload(put)).toMatchObject({ ok: true, bytes: 9 });
		expect(payload(put).sha256).toBe(createHash("sha256").update("hello a2a").digest("hex"));
		const got = await api.call("a2a_file_get", { path: "notes/hello.txt" });
		expect(Buffer.from(String(payload(got).bytes), "base64").toString()).toBe("hello a2a");
		expect(payload(got)).toMatchObject({ totalBytes: 9, eof: true, offset: 0 });
	});

	test("written file is 0600 and lands inside the root", async () => {
		const api = tools();
		await api.call("a2a_file_put", { path: "perm.txt", file: { bytes: b64("x") } });
		const abs = join(dir, "root", "perm.txt");
		expect((await lstat(abs)).mode & 0o777).toBe(0o600);
	});

	test("overwrite is opt-in", async () => {
		const api = tools();
		await api.call("a2a_file_put", { path: "dup.txt", file: { bytes: b64("one") } });
		const again = await api.call("a2a_file_put", { path: "dup.txt", file: { bytes: b64("two") } });
		expect(again.isError).toBe(true);
		expect(errText(again)).toContain("already_exists");
		await api.call("a2a_file_put", { path: "dup.txt", file: { bytes: b64("two") }, overwrite: true });
		expect(await readFile(join(dir, "root", "dup.txt"), "utf8")).toBe("two");
	});

	test("traversal and absolute paths are refused before any write", async () => {
		const api = tools();
		for (const path of ["../escape.txt", "/etc/passwd", "a/../../b", "~/x", "./x"]) {
			const r = await api.call("a2a_file_put", { path, file: { bytes: b64("nope") } });
			expect(r.isError).toBe(true);
			expect(errText(r)).toContain("invalid_path");
		}
	});

	test("inline payload above the cap is refused with a pointer to the chunk API", async () => {
		const api = tools();
		const r = await api.call("a2a_file_put", {
			path: "big.txt",
			file: { bytes: b64("x".repeat(600 * 1024)) },
		});
		expect(r.isError).toBe(true);
		expect(errText(r)).toContain("a2a_file_put_start");
	});

	test("get pages with offset/limit and reports eof", async () => {
		const api = tools();
		await api.call("a2a_file_put", { path: "page.txt", file: { bytes: b64("0123456789") } });
		const p1 = await api.call("a2a_file_get", { path: "page.txt", offset: 0, limit: 4 });
		expect(payload(p1)).toMatchObject({ totalBytes: 10, eof: false });
		expect(Buffer.from(String(payload(p1).bytes), "base64").toString()).toBe("0123");
		const p3 = await api.call("a2a_file_get", { path: "page.txt", offset: 8, limit: 4 });
		expect(payload(p3)).toMatchObject({ eof: true });
		expect(Buffer.from(String(payload(p3).bytes), "base64").toString()).toBe("89");
	});

	test("get of a missing file / directory reports the code", async () => {
		const api = tools();
		await mkdir(join(dir, "root", "adir"), { recursive: true });
		expect(errText(await api.call("a2a_file_get", { path: "gone.txt" }))).toContain("not_found");
		expect(errText(await api.call("a2a_file_get", { path: "adir" }))).toContain("is_a_directory");
	});

	test("get refuses to follow a symlink out of the root", async () => {
		const api = tools();
		await writeFile(join(dir, "outside.txt"), "secret");
		await symlink(join(dir, "outside.txt"), join(dir, "root", "link.txt"));
		const r = await api.call("a2a_file_get", { path: "link.txt" });
		expect(r.isError).toBe(true);
		expect(errText(r)).toContain("symlink_refused");
	});
});

describe("chunked transfer", () => {
	test("start/chunk/end assembles in order and reports the final digest", async () => {
		const api = tools();
		const start = await api.call("a2a_file_put_start", { path: "up.bin", totalBytes: 6 });
		expect(start.isError).toBe(false);
		const id = String(payload(start).transferId);
		for (const [seq, part] of ["abc", "def"].entries()) {
			const c = await api.call("a2a_file_put_chunk", { transferId: id, seq, bytes: b64(part) });
			expect(c.isError).toBe(false);
			expect(payload(c)).toMatchObject({ nextSeq: seq + 1 });
		}
		const end = await api.call("a2a_file_put_end", { transferId: id });
		expect(payload(end)).toMatchObject({ ok: true, bytes: 6 });
		expect(await readFile(join(dir, "root", "up.bin"), "utf8")).toBe("abcdef");
	});

	test("end creates the destination's parent directory", async () => {
		const api = tools();
		const start = await api.call("a2a_file_put_start", { path: "deep/nested/up.bin", totalBytes: 3 });
		const id = String(payload(start).transferId);
		await api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: b64("xyz") });
		expect(payload(await api.call("a2a_file_put_end", { transferId: id }))).toMatchObject({ ok: true, bytes: 3 });
		expect(await readFile(join(dir, "root", "deep", "nested", "up.bin"), "utf8")).toBe("xyz");
	});

	test("out-of-order chunks are refused", async () => {
		const api = tools();
		const id = String(payload(await api.call("a2a_file_put_start", { path: "oo.bin" })).transferId);
		const bad = await api.call("a2a_file_put_chunk", { transferId: id, seq: 1, bytes: b64("x") });
		expect(errText(bad)).toContain("bad_chunk_order");
	});

	test("end without any chunk, and size mismatch, are refused", async () => {
		const api = tools();
		const id = String(payload(await api.call("a2a_file_put_start", { path: "empty.bin", totalBytes: 10 })).transferId);
		expect(errText(await api.call("a2a_file_put_end", { transferId: id }))).toContain("size_mismatch");
		await api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: b64("abc") });
		const short = await api.call("a2a_file_put_end", { transferId: id });
		expect(errText(short)).toContain("size_mismatch");
	});

	test("a transfer belongs to its session only", async () => {
		const api = tools();
		const id = String(payload(await api.call("a2a_file_put_start", { path: "own.bin" })).transferId);
		const other = await api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: b64("x") }, "victim");
		expect(errText(other)).toContain("unknown_transfer");
	});

	test("transfers expire on idle TTL and the staged part is dropped", async () => {
		const api = tools();
		const id = String(payload(await api.call("a2a_file_put_start", { path: "stale.bin" })).transferId);
		await api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: b64("x") });
		const staged = join(dir, "root", ".tmp", `${id}.part`);
		expect(await exists(staged)).toBe(true);
		clock.t += 31 * 60 * 1000;
		// Any later file call sweeps: this one must now look unknown.
		await api.call("a2a_file_put", { path: "trigger.bin", file: { bytes: b64("y") } });
		expect(errText(await api.call("a2a_file_put_end", { transferId: id }))).toContain("unknown_transfer");
		expect(await exists(staged)).toBe(false);
	});

	test("cumulative bytes past maxFileBytes are refused mid-transfer", async () => {
		const api = tools({ maxFileBytes: 1024 });
		const id = String(payload(await api.call("a2a_file_put_start", { path: "over.bin" })).transferId);
		const big = b64("x".repeat(900));
		expect((await api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: big })).isError).toBe(false);
		const second = await api.call("a2a_file_put_chunk", { transferId: id, seq: 1, bytes: big });
		expect(errText(second)).toContain("too_large");
	});
});

describe("a2a_file_list", () => {
	test("hides the staging dir and reports sizes", async () => {
		const api = tools();
		await api.call("a2a_file_put", { path: "l/one.txt", file: { bytes: b64("12345") } });
		await api.call("a2a_file_put", { path: "l/two.txt", file: { bytes: b64("123") } });
		const r = await api.call("a2a_file_list", { path: "l" });
		const entries = payload(r).entries as Array<Record<string, unknown>>;
		expect(entries.map((e) => e.path).sort()).toEqual(["l/one.txt", "l/two.txt"]);
		expect(entries.find((e) => e.path === "l/one.txt")?.bytes).toBe(5);
		const rootList = payload(await api.call("a2a_file_list", {})).entries as Array<Record<string, unknown>>;
		expect(rootList.some((e) => e.path === ".tmp")).toBe(false);
	});
});

describe("tool surface", () => {
	test("exposes the six file tools with closed schemas", () => {
		const built = buildFileTools(makeCfg());
		expect(built.tools.map((t) => t.name)).toEqual([
			"a2a_file_put",
			"a2a_file_put_start",
			"a2a_file_put_chunk",
			"a2a_file_put_end",
			"a2a_file_get",
			"a2a_file_list",
		]);
		for (const t of built.tools) {
			expect(t.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
			expect(t.name.startsWith("a2a_")).toBe(true);
		}
	});

	test("put chunks are excluded from the audit stream while start/end are not", () => {
		const built = buildFileTools(makeCfg());
		const byName = new Map(built.tools.map((t) => [t.name, t]));
		const chunk = byName.get("a2a_file_put_chunk");
		expect(chunk?.skipAudit?.("a2a_file_put_chunk", { transferId: "x", seq: 0, bytes: "AA" })).toBe(true);
		// Without a transferId there is nothing to correlate, so keep the line.
		expect(chunk?.skipAudit?.("a2a_file_put_chunk", {})).toBe(false);
		expect(byName.get("a2a_file_put_start")?.skipAudit).toBeUndefined();
		expect(byName.get("a2a_file_put")?.auditView?.({ path: "p", file: { bytes: "AAAA" } })).toMatchObject({
			file: { bytes: "<base64 len:4>" },
		});
	});
});
