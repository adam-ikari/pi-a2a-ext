import { timingSafeEqual } from "node:crypto";

export function extractBearer(header: string | null): string | null {
	const m = header?.match(/^Bearer\s+(.+)$/i);
	return m ? m[1] : null;
}

export function tokenEqual(a: string, b: string): boolean {
	if (Buffer.byteLength(a) !== Buffer.byteLength(b)) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function authorize(cfg: { token: string }, headers: Headers): boolean {
	const token = extractBearer(headers.get("authorization"));
	return token !== null && tokenEqual(cfg.token, token);
}
