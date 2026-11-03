import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The Sitecommand signing contract (the same one the WordPress connector uses,
 * pinned by the shared fixture in test/fixture.test.ts):
 *
 *   string_to_sign = timestamp + "\n" + METHOD + "\n" + signed_path + "\n" + sha256_hex(raw_body)
 *   signature      = hex(HMAC-SHA256(secret_as_utf8_string, string_to_sign))
 *
 * signed_path is the request path and query exactly as the hub sent it.
 * Requests older or newer than 300 seconds are refused, and each carries a
 * single-use nonce (`sc_nonce` query parameter) so a captured request cannot
 * be replayed.
 */

export const HEADER_TIMESTAMP = "x-sitecommand-timestamp";
export const HEADER_SIGNATURE = "x-sitecommand-signature";
export const HEADER_RESPONSE_SIGNATURE = "x-sitecommand-response-signature";
export const NONCE_PARAM = "sc_nonce";
export const MAX_SKEW_SECONDS = 300;

export function sha256hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function stringToSign(timestamp: string, method: string, signedPath: string, rawBody: string): string {
  return [timestamp, method.toUpperCase(), signedPath, sha256hex(rawBody)].join("\n");
}

export function sign(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** The connector's own signature over its answer, so a cache or look-alike page cannot fake one. */
export function responseSignature(secret: string, nonce: string, body: string): string {
  return sign(secret, `${nonce}\n${sha256hex(body)}`);
}

export type VerifyResult = { ok: true; nonce: string } | { ok: false; reason: "missing" | "stale" | "bad_signature" | "replay" | "no_secret" };

/** Single-use nonces, held for twice the clock window. In memory; serverless instances each keep their own. */
export class NonceStore {
  private seen = new Map<string, number>();
  constructor(private readonly ttlMs = MAX_SKEW_SECONDS * 2 * 1000, private readonly max = 10_000) {}
  /** true when the nonce is new (and now taken). */
  take(nonce: string, now = Date.now()): boolean {
    if (this.seen.size > this.max) for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k);
    if (this.seen.size > this.max) this.seen.clear();
    const exp = this.seen.get(nonce);
    if (exp && exp > now) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }
}

export function verify(
  input: { secret: string | undefined; method: string; signedPath: string; rawBody: string; timestamp: string | null; signature: string | null; nonce: string | null },
  nonces: NonceStore,
  now = Date.now(),
): VerifyResult {
  if (!input.secret || input.secret.length < 32) return { ok: false, reason: "no_secret" };
  if (!input.timestamp || !input.signature || !input.nonce || !/^[A-Za-z0-9_-]{8,128}$/.test(input.nonce)) return { ok: false, reason: "missing" };
  if (!/^\d{9,12}$/.test(input.timestamp) || Math.abs(now / 1000 - Number(input.timestamp)) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale" };
  const expected = sign(input.secret, stringToSign(input.timestamp, input.method, input.signedPath, input.rawBody));
  if (!safeEqualHex(expected, input.signature.toLowerCase())) return { ok: false, reason: "bad_signature" };
  if (!nonces.take(input.nonce, now)) return { ok: false, reason: "replay" };
  return { ok: true, nonce: input.nonce };
}
