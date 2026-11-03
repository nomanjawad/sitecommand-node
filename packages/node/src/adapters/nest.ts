/**
 * NestJS (Express or Fastify platform). In main.ts, before app.listen():
 *
 *   import { useSitecommand } from "@sitecommand/node/nest";
 *   useSitecommand(app, sc);
 *
 * It mounts the connector on the underlying HTTP adapter (no Nest module or
 * decorators needed) and records unhandled errors through a global filter-free hook.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Sitecommand } from "../core.js";
import { nodeHandler } from "./http.js";

type NestApp = {
  getHttpAdapter: () => { getType?: () => string; getInstance: () => any };
  use?: (fn: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void) => unknown;
};

export function useSitecommand(app: NestApp, sc: Sitecommand): void {
  sc.framework = "nestjs";
  const handle = nodeHandler(sc);
  const adapter = app.getHttpAdapter();
  const type = adapter.getType?.() ?? "express";
  const instance = adapter.getInstance();
  if (type === "fastify") {
    instance.addHook("onRequest", async (request: { raw: IncomingMessage }, reply: { raw: ServerResponse; hijack: () => void }) => {
      const path = (request.raw.url ?? "/").split("?")[0] ?? "/";
      if (!sc.owns(path)) return;
      reply.hijack();
      await handle(request.raw, reply.raw);
    });
    instance.addHook("onError", async (request: { method?: string; url?: string }, _r: unknown, error: unknown) => sc.captureError(error, `${request.method ?? ""} ${request.url ?? ""}`));
    return;
  }
  const mw = (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse, next: (err?: unknown) => void) => {
    if (req.originalUrl) req.url = req.originalUrl;
    handle(req, res).then((done) => (done ? undefined : next()), next);
  };
  if (app.use) app.use(mw);
  else instance.use(mw);
}
