import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertRelativeSegments,
	assertRootDoesNotContain,
	ensureRoot,
	FileOpError,
	readSlice,
	resolveInRoot,
	writeFileAtomic,
} from "../src/fileguard.ts";

let dir: string;
let root: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "a2a-guard-"));
	root = await ensureRoot(join(dir, "files"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("assertRelativeSegments", () => {
	test("accepts ordinary relative paths", () => {
		expect(assertRelativeSegments("a/b.txt")).toEqual(["a", "b.txt"]);
		expect(assertRelativeSegments("a..b")).toEqual(["a..b"]);
	});
	test("rejects non-string / empty / oversized", () => {
		for (const bad of [undefined, null, 42, "", "x".repeat(513)]) {
			expect(() => assertRelativeSegments(bad)).toThrow(FileOpError);
		}
	});
	test("rejects absolute forms", () => {
		for (const bad of ["/etc/passwd", "C:\\Windows", "\\\\srv\\share", "~/secret"]) {
			expect(() => assertRelativeSegments(bad)).toThrow("relative");
		}
	});
	test("rejects traversal, dot segments, empty segments, NUL and control chars", () => {
		for (const bad of ["../x", "a/../../x", "./a", "a/./b", "a//b", "a/", "a\x00b", "a\nb"]) {
			expect(() => assertRelativeSegments(bad)).toThrow(FileOpError);
		}
	});
	test("rejects overlong segments", () => {
		expect(() => assertRelativeSegments(`a/${"x".repeat(256)}`)).toThrow("too long");
	});
});

describe("resolveInRoot", () => {
	test("stays inside the root", async () => {
		expect(await resolveInRoot(root, "a/b.txt")).toBe(join(root, "a", "b.txt"));
	});
	test("a symlinked directory inside the root cannot redirect outside", async () => {
		await mkdir(join(root, "real"), { recursive: true });
		await symlink(dir, join(root, "escape"));
		let threw = false;
		try {
			await resolveInRoot(root, "escape/x");
		} catch (e) {
			threw = (e as FileOpError).code === "escapes_root";
		}
		expect(threw).toBe(true);
	});
	test("a symlinked parent directory is redirected and rejected", async () => {
		await mkdir(join(root, "inside"), { recursive: true });
		await symlink(join(root, "inside"), join(root, "parent-link"));
		// "parent-link/out/file.txt": the missing grandchild forces the walk
		// through the symlinked parent, whose realpath stays inside → allowed.
		expect(await resolveInRoot(root, "parent-link/out/file.txt")).toBe(join(root, "inside", "out", "file.txt"));
		// "escape/out/file.txt": realpath leaves the root → rejected.
		let threw = false;
		try {
			await resolveInRoot(root, "escape/out/file.txt");
		} catch (e) {
			threw = (e as FileOpError).code === "escapes_root";
		}
		expect(threw).toBe(true);
	});
});

describe("assertRootDoesNotContain", () => {
	test("refuses a root that would swallow the config file", () => {
		expect(() => assertRootDoesNotContain("/home/x/.omp", ["/home/x/.omp/agent/a2a-bridge.json"])).toThrow(
			"must not contain",
		);
		expect(() =>
			assertRootDoesNotContain("/home/x/.omp/a2a-bridge-files", ["/home/x/.omp/agent/a2a-bridge.json"]),
		).not.toThrow();
	});
});

describe("ensureRoot", () => {
	test("creates 0700 dir and .tmp, purges stale staging files", async () => {
		const fresh = join(dir, "fresh-root");
		const rootReal = await ensureRoot(fresh);
		expect((await lstat(rootReal)).mode & 0o777).toBe(0o700);
		await writeFile(join(rootReal, ".tmp", "stale.part"), "junk");
		const again = await ensureRoot(fresh);
		expect(again).toBe(rootReal);
		let gone = false;
		try {
			await lstat(join(rootReal, ".tmp", "stale.part"));
		} catch (e) {
			gone = (e as NodeJS.ErrnoException).code === "ENOENT";
		}
		expect(gone).toBe(true);
	});
	test("refuses a symlinked root", async () => {
		const link = join(dir, "link-root");
		await symlink(dir, link);
		let threw = false;
		try {
			await ensureRoot(link);
		} catch (e) {
			threw = (e as FileOpError).code === "symlink_refused";
		}
		expect(threw).toBe(true);
	});
});

describe("writeFileAtomic", () => {
	test("writes 0600 with sha256, no overwrite without flag", async () => {
		const data = new TextEncoder().encode("hello");
		const r = await writeFileAtomic(root, "w/a.txt", data);
		expect(r.bytes).toBe(5);
		expect(r.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
		expect(await readFile(r.abs)).toEqual(Buffer.from("hello"));
		expect((await lstat(r.abs)).mode & 0o777).toBe(0o600);
		let threw = false;
		try {
			await writeFileAtomic(root, "w/a.txt", data);
		} catch (e) {
			threw = (e as FileOpError).code === "already_exists";
		}
		expect(threw).toBe(true);
		await writeFileAtomic(root, "w/a.txt", new TextEncoder().encode("bye"), { overwrite: true });
		expect(await readFile(join(root, "w", "a.txt"), "utf8")).toBe("bye");
	});
	test("refuses a symlinked destination", async () => {
		await writeFile(join(root, "victim.txt"), "original");
		await symlink(join(root, "victim.txt"), join(root, "via-link.txt"));
		let threw = false;
		try {
			await writeFileAtomic(root, "via-link.txt", new TextEncoder().encode("x"), { overwrite: true });
		} catch (e) {
			threw = (e as FileOpError).code === "symlink_refused";
		}
		expect(threw).toBe(true);
		expect(await readFile(join(root, "victim.txt"), "utf8")).toBe("original");
	});
});

describe("readSlice", () => {
	beforeAll(async () => {
		await writeFile(join(root, "slice.bin"), Buffer.alloc(1000, 0x41));
	});
	test("full read and offset/limit window", async () => {
		const full = await readSlice(root, "slice.bin");
		expect(full.total).toBe(1000);
		expect(full.buf.length).toBe(1000);
		const part = await readSlice(root, "slice.bin", 900, 256);
		expect(part.buf.length).toBe(100);
		expect(part.total).toBe(1000);
	});
	test("offset past EOF -> invalid_path; missing -> not_found; dir -> is_a_directory", async () => {
		let code = "";
		try {
			await readSlice(root, "slice.bin", 1001);
		} catch (e) {
			code = (e as FileOpError).code;
		}
		expect(code).toBe("invalid_path");
		await expect(readSlice(root, "nope.bin")).rejects.toThrow();
		await mkdir(join(root, "d"), { recursive: true });
		let dirCode = "";
		try {
			await readSlice(root, "d");
		} catch (e) {
			dirCode = (e as FileOpError).code;
		}
		expect(dirCode).toBe("is_a_directory");
	});
	test("refuses reading through a symlink", async () => {
		let threw = false;
		try {
			await readSlice(root, "via-link.txt");
		} catch (e) {
			threw = (e as FileOpError).code === "symlink_refused";
		}
		expect(threw).toBe(true);
	});
});
