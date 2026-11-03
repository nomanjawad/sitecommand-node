/**
 * Next.js App Router. Create app/api/sitecommand/[...path]/route.ts:
 *
 *   import { sc } from "@/sitecommand";            // your sitecommand() instance
 *   import { routeHandlers } from "@sitecommand/node/next";
 *   export const { GET, POST } = routeHandlers(sc);
 *   export const dynamic = "force-dynamic";
 *
 * Errors: add `onRequestError` from this module to instrumentation.ts to record server errors.
 */
import type { Sitecommand } from "../core.js";

export function routeHandlers(sc: Sitecommand) {
  sc.framework = "nextjs";
  const handler = async (request: Request): Promise<Response> => (await sc.handle(request)) ?? new Response("Not Found", { status: 404 });
  return { GET: handler, POST: handler };
}

/** For instrumentation.ts: `export const onRequestError = recordRequestErrors(sc);` */
export function recordRequestErrors(sc: Sitecommand) {
  return async (error: unknown, request: { path?: string; method?: string }) => {
    sc.captureError(error, `${request.method ?? ""} ${request.path ?? ""}`.trim());
  };
}
