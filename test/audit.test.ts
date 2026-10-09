import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { auditDone, auditStart } from "../src/audit.ts";

/**
 * Rotation retention.
 *
 * docs/protocol.md tells callers to read the audit log for a `start` with no
 * `done` as the hang signal, and warns that the evidence ages out. Both halves
 * come from `rename(file, `${file}.1`)` overwriting the previous `.1`: one
 * generation is kept, so a record survives at most two rotations.
 *
 * Proving that against a live host is expensive (test/hardening.ts has to push a
 * couple of hundred deliberately fattened calls through a real host to cross 512 KB
 * once, and the pair-splitting it checks there is a different fact from retention).
 * Here the log is the only thing under test.
 */
describe("audit rotation retention", () => {
	const dir = `/tmp/a2a-audit-retention-${process.pid}`;
	const file = join(dir, "audit.log");
	const rolled = `${file}.1`;
	const env = { A2A_BRIDGE_AUDIT: file } as NodeJS.ProcessEnv;

	// Values under the 120-char leaf cap survive redaction, and serializeArgs then
	// truncates the whole args string at 1024 chars, so each record is ~1.1 KB and
	// one generation holds roughly 475 of them.
	const fatter: Record<string, string> = {};
	for (let k = 0; k < 10; k++) fatter[`f${k}`] = "y".repeat(110);

	const has = (needle: string) => [file, rolled].some((p) => existsSync(p) && readFileSync(p, "utf8").includes(needle));

	const sizes = () => [file, rolled].map((p) => (existsSync(p) ? String(statSync(p).size) : "none")).join("|");

	const flush = async () => {
		// Appends are fire-and-forget by design (auditing must never delay a call), so
		// wait for the two files to stop changing instead of guessing a sleep.
		let last = "";
		for (let i = 0; i < 1200; i++) {
			await Bun.sleep(5);
			const now = sizes();
			if (now === last && now !== "none|none") return;
			last = now;
		}
		throw new Error("audit appends did not settle");
	};

	/**
	 * Enough pairs to cross the 512 KB cap at least once. Appends are dispatched
	 * concurrently by design, and a chain that stat'd before another crossed the cap
	 * can overshoot it, so the loop yields every 20 pairs: the retention fact is
	 * about size, and racing 1200 chains at once would only blur it.
	 */
	const phase = async (tag: string, pairs = 300) => {
		for (let i = 0; i < pairs; i++) {
			auditStart(`${tag}-${i}`, "sid", "read", fatter, env);
			auditDone(`${tag}-${i}`, "sid", "read", fatter, false, env);
			if (i % 20 === 0) await Bun.sleep(1);
		}
		await flush();
		await Bun.sleep(200); // let the last few in-flight appends land
	};

	test("a record survives at most one further rotation", async () => {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });

		// 200 records is ~220 KB, well under the cap: the log is a single file and
		// every record is readable. This is the state a caller greps in.
		await phase("gen-a", 100);
		expect(has('"id":"gen-a-0"')).toBe(true);

		await phase("gen-b");
		await phase("gen-c");
		await phase("gen-d");

		// 1800 records more, ~2 MB, through a log that keeps one `.1`. The evidence of
		// a call that never completed therefore has an expiry date: enough later
		// traffic and it is in neither file.
		expect(has('"id":"gen-a-0"')).toBe(false);
		expect(has('"id":"gen-b-0"')).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	}, 120_000);
});

/**
 * The invariant behind `appendLine`'s swallowed rejection: auditing must never fail
 * or delay the call itself. Two ways a record could go missing — args the log
 * cannot serialize, and a path it cannot write to.
 */
describe("audit never loses a call", () => {
	const dir = `/tmp/a2a-audit-invariant-${process.pid}`;
	const env = { A2A_BRIDGE_AUDIT: join(dir, "audit.log") } as NodeJS.ProcessEnv;

	const readRecords = () => {
		const file = env.A2A_BRIDGE_AUDIT as string;
		if (!existsSync(file)) return [];
		return readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
	};

	const recordFor = async (id: string) => {
		for (let i = 0; i < 300; i++) {
			const hit = readRecords().find((r) => r.id === id);
			if (hit) return hit;
			await Bun.sleep(10);
		}
		return undefined;
	};

	beforeAll(() => {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("args that JSON.stringify rejects are still recorded", async () => {
		// A custom tool can hand over a BigInt and `JSON.stringify` throws on it. The
		// record survives that; its args do not, which is the accepted half of the
		// trade — a vague line beats no line for the `start` without `done` lookup.
		expect(() => auditStart("big-start", "sid", "read", { when: 10n }, env)).not.toThrow();
		expect(() => auditDone("big-done", "sid", "read", { when: 10n }, false, env)).not.toThrow();
		// Distinct ids, not one pair: both appends are in flight at once and their
		// order in the file is not a contract.
		const start = await recordFor("big-start");
		const done = await recordFor("big-done");
		expect(start).toMatchObject({ tool: "read", phase: "start" });
		expect(done).toMatchObject({ tool: "read", phase: "done", isError: false });
		expect(String(start?.args)).not.toContain("10");
	});

	test("args that are absent are recorded as absent, not dropped", async () => {
		// `tools/call` without `arguments` reaches this as undefined, and
		// JSON.stringify(undefined) is undefined rather than a string.
		await auditStart("none-1", "sid", "read", undefined, env);
		const rec = await recordFor("none-1");
		expect(rec?.args).toBe("undefined");
	});

	test("an unwritable log path does not reach the caller or the process", async () => {
		// The `appendLine` chain ends in `.catch(() => {})` for a reason: an audit
		// failure that surfaces as an unhandled rejection noise-floods the host's own
		// error log, which is a worse outcome than a missing line.
		const dead = { A2A_BRIDGE_AUDIT: join(dir, "no-such-dir", "audit.log") } as NodeJS.ProcessEnv;
		const unhandled: unknown[] = [];
		const collect = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", collect);
		try {
			expect(() => auditStart("dead-1", "sid", "read", { path: "/etc/hostname" }, dead)).not.toThrow();
			expect(() => auditDone("dead-1", "sid", "read", { path: "/etc/hostname" }, true, dead)).not.toThrow();
			await Bun.sleep(50); // the rejected appends settle in the background
		} finally {
			process.off("unhandledRejection", collect);
		}
		expect(unhandled).toEqual([]);
	});
});
