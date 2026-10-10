import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditDone, auditStart, auditWriteFailures } from "../src/audit.ts";

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
	 * Enough pairs to cross the 512 KB cap at least once. The pairs go out back to
	 * back: `appendLine` hands each line to one process-wide chain, so there is no
	 * interleaving left to blur the size, and how fast they arrive does not change
	 * which records survive.
	 */
	const phase = async (tag: string, pairs = 300) => {
		for (let i = 0; i < pairs; i++) {
			auditStart(`${tag}-${i}`, "sid", "read", fatter, env);
			auditDone(`${tag}-${i}`, "sid", "read", fatter, false, env);
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
		// The `appendLine` chain ends in a `.catch` for a reason: an audit
		// failure that surfaces as an unhandled rejection noise-floods the host's own
		// error log, which is a worse outcome than a missing line. Swallowed is not
		// silent, though — the log is the only trace of a `POST /blob`, so a bridge that
		// cannot write it has to say so once and keep a count.
		const dead = { A2A_BRIDGE_AUDIT: join(dir, "no-such-dir", "audit.log") } as NodeJS.ProcessEnv;
		const unhandled: unknown[] = [];
		const collect = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", collect);
		const before = auditWriteFailures();
		const printed: string[] = [];
		const realError = console.error;
		console.error = (...a: unknown[]) => printed.push(a.map(String).join(" "));
		try {
			expect(() => auditStart("dead-1", "sid", "read", { path: "/etc/hostname" }, dead)).not.toThrow();
			expect(() => auditDone("dead-1", "sid", "read", { path: "/etc/hostname" }, true, dead)).not.toThrow();
			await Bun.sleep(50); // the rejected appends settle in the background
		} finally {
			console.error = realError;
			process.off("unhandledRejection", collect);
		}
		expect(unhandled).toEqual([]);
		expect(auditWriteFailures()).toBeGreaterThanOrEqual(before + 2);
		expect(
			printed.some((l) => l.includes("audit record not written") && l.includes(dead.A2A_BRIDGE_AUDIT as string)),
		).toBe(true);
	});
});

/**
 * Concurrent writes across the rotation boundary.
 *
 * `appendLine` does `stat` then `rename` then `appendFile`, and those three are not
 * one step. Two calls that are in flight together can both read a size over the cap
 * and both rotate, and the second `rename` writes over the `.1` the first one just
 * put the previous generation into. The loss lands on whichever records happened to
 * sit in the current file when the extra rotation fired, written milliseconds
 * earlier, plus the whole generation that was rotated out of the way. The docs
 * promise one retained generation and the pair readable across both files; under
 * this race a call's `start` can be in neither, and a `POST /blob` — whose audit
 * line is its only trace, the endpoint does not go through the host's approval
 * gate — can leave no trace at all.
 *
 * The log is primed to just under 512 KB and hit with a burst, so exactly one
 * rotation is needed to hold everything. That is the line the test draws: one
 * rotation keeps every record visible across the two files, any extra rotation has
 * eaten data. Measured on the unsynchronized version over six runs, two outcomes:
 * the worst left one record in each file, 570 of the 572 written being in neither;
 * the mildest left 1 of the 60 burst records. Each extra rotation carries away
 * whatever file it fired on, records written milliseconds earlier included.
 */
describe("concurrent writes across the rotation boundary", () => {
	const dir = `/tmp/a2a-audit-race-${process.pid}`;
	const file = join(dir, "audit.log");
	const rolled = `${file}.1`;
	const env = { A2A_BRIDGE_AUDIT: file } as NodeJS.ProcessEnv;

	// The cap in src/audit.ts, and the padding to sit just under it.
	const MAX_LOG_BYTES = 512 * 1024;
	const BURST = 60;

	// ~1.15 KB per record: below the 120-char leaf cap so redaction leaves it alone,
	// below the 1024-char args cut so nothing is truncated.
	const fatter: Record<string, string> = {};
	for (let k = 0; k < 10; k++) fatter[`f${k}`] = "y".repeat(110);

	const primeLine = (id: string) =>
		`${JSON.stringify({ ts: "0", id, sid: "prime", phase: "start", tool: "read", args: "p".repeat(940) })}\n`;

	const idsOnDisk = () => {
		const out = new Set<string>();
		for (const p of [file, rolled]) {
			if (!existsSync(p)) continue;
			for (const line of readFileSync(p, "utf8").split("\n").filter(Boolean)) {
				try {
					out.add(JSON.parse(line).id as string);
				} catch {
					/* a torn line is its own failure; the count below catches it */
				}
			}
		}
		return out;
	};

	const sizes = () => [file, rolled].map((p) => (existsSync(p) ? String(statSync(p).size) : "none")).join("|");

	test("one rotation, and every record written is still readable", async () => {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });

		let prime = "";
		let primeCount = 0;
		while (prime.length + primeLine(`prime-${primeCount}`).length < MAX_LOG_BYTES - 200) {
			prime += primeLine(`prime-${primeCount++}`);
		}
		writeFileSync(file, prime);
		const headroom = MAX_LOG_BYTES - statSync(file).size;
		// The burst has to overflow the headroom, otherwise nothing rotates and the
		// test proves only that an untouched log is fine.
		expect(BURST * 1150).toBeGreaterThan(headroom);

		for (let i = 0; i < BURST; i++) auditStart(`race-${i}`, "sid", "read", fatter, env);

		// Appends are fire-and-forget, so wait for the two files to stop changing.
		let last = "";
		for (let i = 0; i < 1200; i++) {
			await Bun.sleep(5);
			const now = sizes();
			if (now === last && now !== "none|none") break;
			last = now;
		}
		await Bun.sleep(300);

		const seen = idsOnDisk();
		const missing = [
			...Array.from({ length: primeCount }, (_, i) => `prime-${i}`),
			...Array.from({ length: BURST }, (_, i) => `race-${i}`),
		].filter((id) => !seen.has(id));

		// Every record survives: the burst crosses the cap once, the previous
		// generation lands in `.1`, and nothing overwrites it.
		expect(missing.slice(0, 5)).toEqual([]);
		expect(missing.length).toBe(0);

		rmSync(dir, { recursive: true, force: true });
	}, 120_000);
});
