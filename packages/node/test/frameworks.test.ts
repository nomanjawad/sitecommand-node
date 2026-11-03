import { afterAll, describe, expect, it } from "vitest";
import express from "express";
import Fastify from "fastify";
import { Hono } from "hono";
import { sitecommand, sign, stringToSign } from "../src/index";
import { sitecommandExpress, sitecommandErrors } from "../src/adapters/express";
import { sitecommandFastify } from "../src/adapters/fastify";
import { sitecommandHono } from "../src/adapters/hono";
import { routeHandlers } from "../src/adapters/next";

const secret = "f".repeat(64);
let n = 0;
function headersFor(method: string, path: string, body = "") {
  const ts = String(Math.floor(Date.now() / 1000));
  return { "x-sitecommand-timestamp": ts, "x-sitecommand-signature": sign(secret, stringToSign(ts, method, path, body)), "content-type": "application/json" };
}
const nonce = () => `fw${Date.now()}${n++}`;
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

describe("Express", () => {
  it("answers signed requests, passes the rest on, and records route errors", async () => {
    const sc = sitecommand({ secret, actions: { echo: { description: "Echo", input: { word: "string" }, run: ({ word }: { word: string }) => word } } });
    const app = express();
    app.use(sitecommandExpress(sc));
    app.use(express.json());
    app.get("/", (_q, r) => void r.send("home"));
    app.get("/boom", () => {
      throw new Error("token=abc123def boom");
    });
    app.use(sitecommandErrors(sc));
    const server = app.listen(0);
    closers.push(() => new Promise((r) => server.close(() => r())));
    const port = (server.address() as { port: number }).port;
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("home");
    await fetch(`http://127.0.0.1:${port}/boom`);
    const path = `/api/sitecommand/errors?sc_nonce=${nonce()}`;
    const errs = await (await fetch(`http://127.0.0.1:${port}${path}`, { headers: headersFor("GET", path) })).json();
    expect(errs.errors[0].where).toBe("GET /boom");
    expect(errs.errors[0].message).not.toContain("abc123def");
    const body = JSON.stringify({ input: { word: "hi" } });
    const apath = `/api/sitecommand/actions/echo?sc_nonce=${nonce()}`;
    const out = await (await fetch(`http://127.0.0.1:${port}${apath}`, { method: "POST", body, headers: headersFor("POST", apath, body) })).json();
    expect(out.result).toBe("hi");
    expect(sc.framework).toBe("express");
  });
});

describe("Fastify", () => {
  it("answers signed requests and leaves the app's routes alone", async () => {
    const sc = sitecommand({ secret });
    const app = Fastify();
    await app.register(sitecommandFastify(sc));
    app.get("/", async () => "home");
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => app.close());
    expect(await (await fetch(`${address}/`)).text()).toBe("home");
    const path = `/api/sitecommand/info?sc_nonce=${nonce()}`;
    const info = await (await fetch(`${address}${path}`, { headers: headersFor("GET", path) })).json();
    expect(info.framework).toBe("fastify");
    expect((await fetch(`${address}/api/sitecommand/info`)).status).toBe(404);
  });
});

describe("Hono", () => {
  it("answers through app.request", async () => {
    const sc = sitecommand({ secret });
    const app = new Hono();
    app.use("*", sitecommandHono(sc));
    app.get("/", (c) => c.text("home"));
    expect(await (await app.request("/")).text()).toBe("home");
    const path = `/api/sitecommand/info?sc_nonce=${nonce()}`;
    const res = await app.request(`http://localhost${path}`, { headers: headersFor("GET", path) });
    expect((await res.json()).framework).toBe("hono");
  });
});

describe("Next.js route handlers", () => {
  it("GET and POST answer the same way", async () => {
    const sc = sitecommand({ secret });
    const { GET } = routeHandlers(sc);
    const path = `/api/sitecommand/info?sc_nonce=${nonce()}`;
    const res = await GET(new Request(`https://app.example.com${path}`, { headers: headersFor("GET", path) }));
    expect((await res.json()).framework).toBe("nextjs");
    expect((await GET(new Request("https://app.example.com/api/sitecommand/info"))).status).toBe(404);
  });
});
