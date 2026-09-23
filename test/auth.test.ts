import { describe, expect, test } from "bun:test";
import { authorize, extractBearer, tokenEqual } from "../src/auth.ts";

describe("extractBearer", () => {
	test("parses the token", () => expect(extractBearer("Bearer abc123")).toBe("abc123"));
	test("scheme match is case-insensitive", () => expect(extractBearer("bearer abc123")).toBe("abc123"));
	test("rejects other schemes", () => expect(extractBearer("Basic dXNlcg==")).toBeNull());
	test("missing header", () => expect(extractBearer(null)).toBeNull());
	test("empty credential", () => expect(extractBearer("Bearer ")).toBeNull());
});

describe("tokenEqual", () => {
	test("equal tokens", () => expect(tokenEqual("abcd", "abcd")).toBe(true));
	test("same length, different content", () => expect(tokenEqual("abcd", "abce")).toBe(false));
	test("different length must not throw", () => expect(tokenEqual("abcd", "abc")).toBe(false));
});

describe("authorize", () => {
	const cfg = { token: "s3cret" };
	const headers = (value: string | null): Headers =>
		new Headers(value === null ? {} : { authorization: value });

	test("accepts the exact token", () => expect(authorize(cfg, headers("Bearer s3cret"))).toBe(true));
	test("rejects a wrong token", () => expect(authorize(cfg, headers("Bearer wrong!!"))).toBe(false));
	test("rejects a missing header", () => expect(authorize(cfg, headers(null))).toBe(false));
});
