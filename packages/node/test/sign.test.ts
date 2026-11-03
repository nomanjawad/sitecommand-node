import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NonceStore, sha256hex, sign, stringToSign, verify } from "../src/sign";

// The same fixture the Sitecommand hub and the WordPress connector are pinned to.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/hmac-signing.json", import.meta.url), "utf8")) as {
  site_secret: string;
  cases: { name: string; timestamp: string; method: string; path: string; raw_body: string; body_sha256: string; string_to_sign: string; signature: string }[];
};

describe("signing contract (shared fixture)", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(sha256hex(c.raw_body)).toBe(c.body_sha256);
      expect(stringToSign(c.timestamp, c.method, c.path, c.raw_body)).toBe(c.string_to_sign);
      expect(sign(fixture.site_secret, c.string_to_sign)).toBe(c.signature);
    });
  }
});

describe("verify", () => {
  const secret = fixture.site_secret;
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const signed = (path: string, body = "", t = ts) => sign(secret, stringToSign(t, "GET", path, body));
  it("accepts a correct request once and refuses the replay", () => {
    const store = new NonceStore();
    const path = "/api/sitecommand/info?sc_nonce=abcdef123456";
    const input = { secret, method: "GET", signedPath: path, rawBody: "", timestamp: ts, signature: signed(path), nonce: "abcdef123456" };
    expect(verify(input, store, now)).toEqual({ ok: true, nonce: "abcdef123456" });
    expect(verify(input, store, now)).toEqual({ ok: false, reason: "replay" });
  });
  it("refuses stale, tampered, unsigned and secretless requests", () => {
    const store = new NonceStore();
    const path = "/api/sitecommand/info?sc_nonce=n0nce00001";
    const base = { secret, method: "GET", signedPath: path, rawBody: "", timestamp: ts, signature: signed(path), nonce: "n0nce00001" };
    expect(verify({ ...base, timestamp: String(now / 1000 - 301), signature: signed(path, "", String(now / 1000 - 301)) }, store, now).ok).toBe(false);
    expect(verify({ ...base, signedPath: "/api/sitecommand/deps?sc_nonce=n0nce00001" }, store, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify({ ...base, signature: null }, store, now)).toEqual({ ok: false, reason: "missing" });
    expect(verify({ ...base, secret: undefined }, store, now)).toEqual({ ok: false, reason: "no_secret" });
    expect(verify({ ...base, secret: "short" }, store, now)).toEqual({ ok: false, reason: "no_secret" });
  });
});
