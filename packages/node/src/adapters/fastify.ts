/**
 * Fastify (4 and 5).
 *
 *   import { sitecommandFastify } from "@sitecommand/node/fastify";
 *   await app.register(sitecommandFastify(sc));
 *
 * Answers the connector's routes before body parsing and records errors through onError.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Sitecommand } from "../core.js";
import { nodeHandler } from "./http.js";

type FastifyLike = {
  addHook: (name: string, fn: (...args: any[]) => unknown) => unknown;
};

export function sitecommandFastify(sc: Sitecommand) {
  sc.framework = "fastify";
  const handle = nodeHandler(sc);
  const plugin = async (app: FastifyLike) => {
    app.addHook("onRequest", async (request: { raw: IncomingMessage }, reply: { raw: ServerResponse; hijack: () => void }) => {
      const path = (request.raw.url ?? "/").split("?")[0] ?? "/";
      if (!sc.owns(path)) return;
      reply.hijack();
      await handle(request.raw, reply.raw);
    });
    app.addHook("onError", async (request: { method?: string; url?: string }, _reply: unknown, error: unknown) => {
      sc.captureError(error, `${request.method ?? ""} ${(request.url ?? "").split("?")[0]}`);
    });
  };
  // Let the plugin's hooks apply to the whole app, not an encapsulated child.
  (plugin as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
  return plugin;
}
