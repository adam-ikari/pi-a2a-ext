import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

	// The seq check and the append must not interleave. Callers are told to
	// impose their own timeout, so two in-flight requests for the same seq are
	// routine; when both passed the check the file was written twice and
	// put_end reported success over corrupted bytes.
	test("concurrent chunks with the same seq do not double-append", async () => {
		const api = tools();
		const id = String(payload(await api.call("a2a_file_put_start", { path: "race.bin", totalBytes: 4 })).transferId);
		const [a, b] = await Promise.all([
			api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: b64("ABCD") }),
			api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: b64("ABCD") }),
		]);
		// One commits, the other is recognized as a resend of the same bytes.
		expect([payload(a).duplicate, payload(b).duplicate].filter(Boolean)).toHaveLength(1);
		const end = await api.call("a2a_file_put_end", { transferId: id });
		expect(payload(end)).toMatchObject({ ok: true, bytes: 4 });
		expect(await readFile(join(dir, "root", "race.bin"), "utf8")).toBe("ABCD");
	});

	// Same race, wider: eight simultaneous copies of one chunk.
	test("an 8-way concurrent same-seq burst still writes one chunk", async () => {
		const api = tools();
		const id = String(payload(await api.call("a2a_file_put_start", { path: "burst.bin", totalBytes: 64 })).transferId);
		const chunk = Buffer.alloc(64, 0xcd).toString("base64");
		const rs = await Promise.all(
			Array.from({ length: 8 }, () => api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: chunk })),
		);
		expect(rs.filter((r) => payload(r).duplicate === true)).toHaveLength(7);
		expect(payload(await api.call("a2a_file_put_end", { transferId: id }))).toMatchObject({ bytes: 64 });
		expect((await readFile(join(dir, "root", "burst.bin"))).equals(Buffer.alloc(64, 0xcd))).toBe(true);
	});

	// Out-of-order seqs racing each other: order must still be enforced, and the
	// duplicates must be absorbed rather than appended.
	test("racing distinct seqs keep the file in order", async () => {
		const api = tools();
		const id = String(payload(await api.call("a2a_file_put_start", { path: "ooo.bin", totalBytes: 12 })).transferId);
		const rs = await Promise.all(
			[2, 1, 0, 0, 1, 2].map((s) =>
				api.call("a2a_file_put_chunk", { transferId: id, seq: s, bytes: b64(String(s).repeat(4)) }),
			),
		);
		const objs = rs.filter((r) => !r.isError).map(payload);
		const accepted = objs.filter((p) => p.duplicate !== true);
		// Each of the 3 distinct seqs is written exactly once, whatever order
		// they arrive in: seqs seen ahead of their turn are refused outright,
		// and only a repeat of an already-accepted seq counts as a duplicate.
		expect(accepted.map((p) => p.nextSeq).sort()).toEqual([1, 2, 3]);
		expect(accepted).toHaveLength(3);
		expect(payload(await api.call("a2a_file_put_end", { transferId: id }))).toMatchObject({ bytes: 12 });
		// The invariant that matters: in order, nothing lost, nothing doubled.
		expect(await readFile(join(dir, "root", "ooo.bin"), "utf8")).toBe("000011112222");
	});

	// A full 100MB transfer is 200 chunks through the serialized queue; if the
	// chain grew unboundedly or wedged, this would hang or drop bytes.
	test("a 200-chunk transfer reassembles byte-exact and drains staging", async () => {
		const api = tools({ maxFileBytes: 100 * 1024 * 1024 });
		const step = 512 * 1024;
		const n = 200;
		const blob = Buffer.alloc(step * n, 0x5a);
		const id = String(
			payload(await api.call("a2a_file_put_start", { path: "huge.bin", totalBytes: blob.length })).transferId,
		);
		for (let s = 0; s < n; s++) {
			const r = await api.call("a2a_file_put_chunk", {
				transferId: id,
				seq: s,
				bytes: blob.subarray(s * step, (s + 1) * step).toString("base64"),
			});
			expect(r.isError).toBe(false);
		}
		expect(payload(await api.call("a2a_file_put_end", { transferId: id }))).toMatchObject({ bytes: blob.length });
		expect((await readFile(join(dir, "root", "huge.bin"))).equals(blob)).toBe(true);
		expect(await readdir(join(dir, "root", ".tmp")).catch(() => [])).toEqual([]);
	}, 30_000);

	test("a resent chunk is idempotent, but a reused seq with other bytes is not", async () => {
		const api = tools();
		const id = String(payload(await api.call("a2a_file_put_start", { path: "retry.bin", totalBytes: 8 })).transferId);
		await api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: b64("AAAA") });
		// Same seq, same bytes -> absorbed, transfer state unchanged.
		expect(payload(await api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: b64("AAAA") }))).toMatchObject(
			{
				duplicate: true,
				receivedBytes: 4,
			},
		);
		// Same seq, different bytes -> a genuine protocol error, not absorbed.
		expect(errText(await api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: b64("BBBB") }))).toContain(
			"bad_chunk_order",
		);
		await api.call("a2a_file_put_chunk", { transferId: id, seq: 1, bytes: b64("BBBB") });
		await api.call("a2a_file_put_end", { transferId: id });
		expect(await readFile(join(dir, "root", "retry.bin"), "utf8")).toBe("AAAABBBB");
	});

	// requireTransfer resolves the record synchronously, but the write itself
	// runs later on the transfer's queue. A put_end that commits in between has
	// already renamed the staged file away, so the queued chunk used to append
	// to a dead path: it reported ok, the bytes were silently lost, and an
	// orphan .part file was left in the staging dir.
	test("a chunk queued behind a committing put_end is refused, not appended", async () => {
		const api = tools();
		// No totalBytes: nothing else would reject the late chunk first.
		const id = String(payload(await api.call("a2a_file_put_start", { path: "orphan.bin" })).transferId);
		await api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: b64("AAAA") });
		await api.call("a2a_file_put_chunk", { transferId: id, seq: 1, bytes: b64("BBBB") });
		const [end, late] = await Promise.all([
			api.call("a2a_file_put_end", { transferId: id }),
			api.call("a2a_file_put_chunk", { transferId: id, seq: 2, bytes: b64("CCCC") }),
		]);
		expect(payload(end)).toMatchObject({ ok: true, bytes: 8 });
		expect(errText(late)).toContain("unknown_transfer");
		// The committed file holds only what was staged before the end.
		expect(await readFile(join(dir, "root", "orphan.bin"), "utf8")).toBe("AAAABBBB");
		// And no .part was resurrected on the renamed path.
		const staged = await readdir(join(dir, "root", ".tmp")).catch(() => [] as string[]);
		expect(staged).toEqual([]);
	});

	test("a failed step does not wedge the transfer for later chunks", async () => {
		const api = tools();
		const id = String(payload(await api.call("a2a_file_put_start", { path: "wedge.bin", totalBytes: 4 })).transferId);
		// Over the declared size: fails, and must not poison the queue.
		expect(errText(await api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: b64("toolarge") }))).toContain(
			"size_mismatch",
		);
		expect(payload(await api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: b64("ABCD") }))).toMatchObject(
			{
				ok: true,
			},
		);
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

	// Only the *children* were symlink-filtered, so a symlinked target was
	// traversed and its names/sizes/mtimes leaked from outside the root.
	test("refuses to list through a symlinked directory", async () => {
		const api = tools();
		const outside = join(dir, "outside-list");
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, "LEAKED.txt"), "secret");
		await symlink(outside, join(dir, "root", "linkdir"));
		const r = await api.call("a2a_file_list", { path: "linkdir" });
		expect(r.isError).toBe(true);
		expect(errText(r)).toContain("symlink_refused");
	});
});

describe("staging directory is not addressable", () => {
	// Transfers are bound to the Mcp-Session-Id that opened them, but the staged
	// bytes are plain files. If `.tmp` were reachable, any client could list
	// in-flight transferIds and read or clobber another session's upload.
	test("a leading .tmp segment is refused by every tool", async () => {
		const api = tools();
		await api.call("a2a_file_put", { path: "seed.bin", file: { bytes: b64("s") } });
		const staged = join(dir, "root", ".tmp", "someone-elses.part");
		await writeFile(staged, "in flight");
		for (const [tool, args] of [
			["a2a_file_list", { path: ".tmp" }],
			["a2a_file_get", { path: ".tmp/someone-elses.part" }],
			["a2a_file_put", { path: ".tmp/x", file: { bytes: b64("x") } }],
			["a2a_file_get", { path: ".tmp/../seed.bin" }],
		] as const) {
			const r = await api.call(tool, args, "attacker");
			expect(r.isError).toBe(true);
			expect(errText(r)).toContain("invalid_path");
		}
		// A nested .tmp is not the staging area and stays legal.
		expect(
			payload(await api.call("a2a_file_put", { path: "sub/.tmp/ok.txt", file: { bytes: b64("k") } })),
		).toMatchObject({
			ok: true,
		});
	});

	test("another session's staged bytes cannot be overwritten", async () => {
		const api = tools();
		const id = String(
			payload(await api.call("a2a_file_put_start", { path: "owned.bin", totalBytes: 4 }, "owner")).transferId,
		);
		await api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: b64("WXYZ") }, "owner");
		const clobber = await api.call(
			"a2a_file_put",
			{ path: `.tmp/${id}.part`, overwrite: true, file: { bytes: b64("0000") } },
			"attacker",
		);
		expect(clobber.isError).toBe(true);
		expect(await readFile(join(dir, "root", ".tmp", `${id}.part`), "utf8")).toBe("WXYZ");
	});
});

describe("error contract", () => {
	// Raw fs errors used to reach the wire verbatim: no a2a_file_error code and
	// absolute host paths in the message.
	test("untranslated host fs errors are coded and path-free", async () => {
		const api = tools();
		await api.call("a2a_file_put", { path: "plainfile", file: { bytes: b64("hello") } });
		for (const [tool, args] of [
			["a2a_file_get", { path: "plainfile/child" }],
			["a2a_file_put", { path: "plainfile/child", file: { bytes: b64("z") } }],
			["a2a_file_list", { path: "plainfile/child" }],
		] as const) {
			const r = await api.call(tool, args);
			expect(r.isError).toBe(true);
			const text = errText(r);
			expect(text).toMatch(/^a2a_file_error [a-z_]+: /);
			// No host path, no errno, no absolute temp dir.
			expect(text).not.toContain(dir);
			expect(text).not.toMatch(/ENOTDIR|EISDIR|ENOENT|node:fs/);
		}
	});

	test("put_end onto a directory is refused as is_a_directory", async () => {
		const api = tools();
		// put_start validates while the target is a file; it becomes a directory
		// before the transfer ends. The rename must still fail closed, and with a
		// code rather than a raw EISDIR carrying host paths.
		await api.call("a2a_file_put", { path: "dir-target", file: { bytes: b64("old") } });
		const id = String(
			payload(await api.call("a2a_file_put_start", { path: "dir-target", totalBytes: 4, overwrite: true })).transferId,
		);
		await api.call("a2a_file_put_chunk", { transferId: id, seq: 0, bytes: b64("ABCD") });
		await rm(join(dir, "root", "dir-target"));
		await mkdir(join(dir, "root", "dir-target"));
		const r = await api.call("a2a_file_put_end", { transferId: id });
		expect(errText(r)).toContain("is_a_directory");
		expect(errText(r)).not.toContain(dir);
	});
});

describe("a2a_file_get digest", () => {
	test("sha256 covers the returned slice, not the whole file", async () => {
		const api = tools();
		await api.call("a2a_file_put", { path: "digest.bin", file: { bytes: b64("0123456789") } });
		const r = payload(await api.call("a2a_file_get", { path: "digest.bin", offset: 2, limit: 3 }));
		expect(r.sha256).toBe(createHash("sha256").update("234").digest("hex"));
		// totalBytes still describes the whole file, so paging is unaffected.
		expect(r.totalBytes).toBe(10);
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
