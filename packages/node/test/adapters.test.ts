import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sitecommand, sign, stringToSign } from "../src/index";
import { nodeHandler } from "../src/adapters/http";

const secret = "k".repeat(64);
const sc = sitecommand({ secret });
let server: Server;
let port = 0;

beforeAll(async () => {
  const handle = nodeHandler(sc);
  server = createServer(async (req, res) => {
    if (await handle(req, res)) return;
    res.end("app");
  });
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("node:http adapter (used by Express, Fastify and NestJS)", () => {
  it("passes other paths to the app", async () => {
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("app");
  });
  it("answers a signed request end to end", async () => {
    const path = "/api/sitecommand/info?sc_nonce=adapter0001";
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "x-sitecommand-timestamp": ts, "x-sitecommand-signature": sign(secret, stringToSign(ts, "GET", path, "")) } });
    expect(res.status).toBe(200);
    expect((await res.json()).connector.name).toBe("@sitecommand/node");
  });
  it("returns 404 for unsigned requests", async () => {
    expect((await fetch(`http://127.0.0.1:${port}/api/sitecommand/info`)).status).toBe(404);
  });
});
