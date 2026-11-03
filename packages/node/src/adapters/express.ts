/**
 * Express (4 and 5).
 *
 *   import { sitecommandExpress, sitecommandErrors } from "@sitecommand/node/express";
 *   app.use(sitecommandExpress(sc));          // before your routes and body parsers
 *   ...your routes...
 *   app.use(sitecommandErrors(sc));           // after your routes: records errors, then passes them on
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Sitecommand } from "../core.js";
import { nodeHandler } from "./http.js";

type Next = (err?: unknown) => void;

export function sitecommandExpress(sc: Sitecommand) {
  sc.framework = "express";
  const handle = nodeHandler(sc);
  return (req: IncomingMessage & { originalUrl?: string; body?: unknown }, res: ServerResponse, next: Next) => {
    // Under app.use("/x", …) Express rewrites req.url: sign against the original path.
    if (req.originalUrl) req.url = req.originalUrl;
    const already = typeof req.body === "string" ? req.body : undefined;
    handle(req, res, already).then((done) => (done ? undefined : next()), next);
  };
}

export function sitecommandErrors(sc: Sitecommand) {
  return (err: unknown, req: IncomingMessage & { originalUrl?: string }, _res: ServerResponse, next: Next) => {
    sc.captureError(err, `${req.method ?? ""} ${(req.originalUrl ?? req.url ?? "").split("?")[0]}`);
    next(err);
  };
}
