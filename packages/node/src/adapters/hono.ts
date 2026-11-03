/**
 * Hono (and anything else that passes a Fetch Request: Bun, Deno, Remix, SvelteKit, Cloudflare-style handlers).
 *
 *   import { sitecommandHono } from "@sitecommand/node/hono";
 *   app.use("*", sitecommandHono(sc));
 *   app.onError((err, c) => { sc.captureError(err, c.req.path); return c.text("Server error", 500); });
 */
import type { Sitecommand } from "../core.js";

type HonoContext = { req: { raw: Request } };

export function sitecommandHono(sc: Sitecommand) {
  sc.framework = "hono";
  return async (c: HonoContext, next: () => Promise<void>) => {
    const response = await sc.handle(c.req.raw);
    if (response) return response;
    await next();
    return undefined;
  };
}

/** For any Fetch-style server: returns the connector's Response, or null to let your app handle it. */
export function fetchHandler(sc: Sitecommand) {
  return (request: Request) => sc.handle(request);
}
