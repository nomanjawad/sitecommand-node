import { describe, expect, it } from "vitest";
import { sitecommand, validateInput, mask, responseSignature, sign, stringToSign } from "../src/index";

const secret = "s".repeat(64);
let n = 0;
function signedRequest(path: string, init: { method?: string; body?: string; secret?: string } = {}) {
  const method = init.method ?? "GET";
  const nonce = `nonce${Date.now()}${n++}`;
  const sep = path.includes("?") ? "&" : "?";
  const full = `${path}${sep}sc_nonce=${nonce}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(init.secret ?? secret, stringToSign(ts, method, full, init.body ?? ""));
  return {
    nonce,
    request: new Request(`https://app.example.com${full}`, { method, body: init.body, headers: { "x-sitecommand-timestamp": ts, "x-sitecommand-signature": sig, "content-type": "application/json" } }),
  };
}

describe("connector", () => {
  const sc = sitecommand({
    secret,
    app: { name: "demo", version: "1.2.3" },
    health: { db: async () => ({ ok: true }), cache: () => false, broken: () => { throw new Error("redis://user:hunter2@cache:6379 refused"); } },
    actions: {
      "recent-signups": { description: "Last sign-ups", input: { limit: "number?" }, run: ({ limit = 2 }: { limit?: number }) => ({ users: ["a", "b", "c"].slice(0, limit) }) },
      "clear-cache": { description: "Clear the cache", changes: true, run: () => "cleared" },
      slow: { description: "Too slow", timeout: 1, run: () => new Promise((r) => setTimeout(r, 2000)) },
    },
  });

  it("ignores paths that are not the connector's", async () => {
    expect(await sc.handle(new Request("https://app.example.com/pricing"))).toBeNull();
  });

  it("answers unsigned and wrongly signed requests with a plain 404", async () => {
    const r1 = await sc.handle(new Request("https://app.example.com/api/sitecommand/info"));
    expect(r1?.status).toBe(404);
    const { request } = signedRequest("/api/sitecommand/info", { secret: "x".repeat(64) });
    expect((await sc.handle(request))?.status).toBe(404);
  });

  it("serves info with a response signature the hub can check", async () => {
    const { request, nonce } = signedRequest("/api/sitecommand/info");
    const res = (await sc.handle(request))!;
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(res.headers.get("x-sitecommand-response-signature")).toBe(responseSignature(secret, nonce, body));
    expect(res.headers.get("cache-control")).toContain("no-store");
    const info = JSON.parse(body);
    expect(info.app).toEqual({ name: "demo", version: "1.2.3" });
    expect(info.actions).toEqual(["recent-signups", "clear-cache", "slow"]);
  });

  it("refuses a replayed request", async () => {
    const { request } = signedRequest("/api/sitecommand/info");
    const copy = request.clone();
    expect((await sc.handle(request))?.status).toBe(200);
    expect((await sc.handle(copy))?.status).toBe(404);
  });

  it("runs health checks and masks secrets in their messages", async () => {
    const { request } = signedRequest("/api/sitecommand/health");
    const out = await (await sc.handle(request))!.json();
    expect(out.ok).toBe(false);
    expect(out.checks.db.ok).toBe(true);
    expect(out.checks.cache.ok).toBe(false);
    expect(out.checks.broken.message).not.toContain("hunter2");
    expect(out.checks.memory.rss_mb).toBeGreaterThan(0);
  });

  it("lists and runs actions with validated input, and times out slow ones", async () => {
    const list = await (await sc.handle(signedRequest("/api/sitecommand/actions").request))!.json();
    expect(list.actions.map((a: { name: string }) => a.name)).toEqual(["recent-signups", "clear-cache", "slow"]);
    const ok = await (await sc.handle(signedRequest("/api/sitecommand/actions/recent-signups", { method: "POST", body: JSON.stringify({ input: { limit: 1 } }) }).request))!.json();
    expect(ok.result).toEqual({ users: ["a"] });
    const bad = await sc.handle(signedRequest("/api/sitecommand/actions/recent-signups", { method: "POST", body: JSON.stringify({ input: { limit: "x" } }) }).request);
    expect(bad?.status).toBe(400);
    const unknown = await sc.handle(signedRequest("/api/sitecommand/actions/nope", { method: "POST", body: "{}" }).request);
    expect(unknown?.status).toBe(404);
    const slow = await (await sc.handle(signedRequest("/api/sitecommand/actions/slow", { method: "POST", body: "{}" }).request))!.json();
    expect(slow.ok).toBe(false);
    expect(slow.message).toContain("Timed out");
  });

  it("records errors once per kind, masked", async () => {
    sc.captureError(new Error("Login failed for jane@example.com with password=supersecret"), "POST /login");
    sc.captureError(new Error("Login failed for jane@example.com with password=supersecret"), "POST /login");
    const out = await (await sc.handle(signedRequest("/api/sitecommand/errors").request))!.json();
    const e = out.errors.find((x: { where: string }) => x.where === "POST /login");
    expect(e.count).toBe(2);
    expect(e.message).not.toContain("jane@example.com");
    expect(e.message).not.toContain("supersecret");
  });

  it("lists dependencies from the lockfile", async () => {
    const out = await (await sc.handle(signedRequest("/api/sitecommand/deps").request))!.json();
    expect(out.ok).toBe(true);
    expect(["package-lock", "pnpm-lock", "yarn-lock", "installed", "none"]).toContain(out.source);
  });
});

describe("helpers", () => {
  it("validates action input strictly", () => {
    expect(validateInput({ a: "string", b: "number?" }, { a: "x" })).toEqual({ ok: true, value: { a: "x" } });
    expect(validateInput({ a: "string" }, {}).ok).toBe(false);
    expect(validateInput({ a: "string" }, { a: "x", extra: 1 }).ok).toBe(false);
    expect(validateInput({ a: "number" }, { a: Number.NaN }).ok).toBe(false);
    expect(validateInput({}, [] as unknown).ok).toBe(false);
  });
  it("masks common secret shapes", () => {
    const m = mask("postgres://admin:pw@db:5432/x Bearer abcdefghijklmnop sk_live_abcdefghijklmnop token=abc123 AKIAABCDEFGHIJKLMNOP me@x.io");
    for (const s of ["admin:pw", "abcdefghijklmnop", "sk_live_", "abc123", "AKIAABCDEFGHIJKLMNOP", "me@x.io"]) expect(m).not.toContain(s);
  });
});
