/**
 * Any Node server built on node:http (and frameworks that expose req/res).
 *
 *   import { nodeHandler } from "@sitecommand/node/http";
 *   const handle = nodeHandler(sc);
 *   http.createServer(async (req, res) => { if (await handle(req, res)) return; ...your app... });
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Sitecommand } from "../core.js";

const MAX_BODY = 1_000_000;

export async function toRequest(req: IncomingMessage, rawBody?: string): Promise<Request> {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? "localhost";
  const url = `${proto}://${host}${req.url ?? "/"}`;
  let body = rawBody;
  if (body === undefined && req.method !== "GET" && req.method !== "HEAD") {
    body = await new Promise<string>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error("Body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  return new Request(url, { method: req.method, headers, body: body || undefined });
}

export async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(await response.text());
}

/** Returns true when the request was the connector's (and has been answered). */
export function nodeHandler(sc: Sitecommand) {
  return async (req: IncomingMessage, res: ServerResponse, rawBody?: string): Promise<boolean> => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (!sc.owns(path)) return false;
    const response = await sc.handle(await toRequest(req, rawBody));
    await send(res, response ?? new Response("Not Found", { status: 404 }));
    return true;
  };
}
