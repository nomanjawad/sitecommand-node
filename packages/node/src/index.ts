/**
 * @sitecommand/node — connect a Node app to Sitecommand.
 *
 *   import { sitecommand } from "@sitecommand/node";
 *   export const sc = sitecommand({ health: { db: () => db.ping() } });
 *
 * Then mount it with the adapter for your framework (see README):
 * `@sitecommand/node/next`, `/express`, `/fastify`, `/hono`, `/nest`, `/http`,
 * or call `sc.handle(request)` from any server that speaks Fetch `Request`.
 */
import { Sitecommand, type SitecommandOptions } from "./core.js";

export { Sitecommand, VERSION, validateInput } from "./core.js";
export type { Action, CheckResult, ErrorRecord, HealthCheck, InputSpec, SitecommandOptions } from "./core.js";
export { mask } from "./mask.js";
export { readDependencies, type Dependency, type DependencyReport } from "./deps.js";
export { stringToSign, sign, responseSignature, sha256hex, HEADER_TIMESTAMP, HEADER_SIGNATURE, HEADER_RESPONSE_SIGNATURE, NONCE_PARAM } from "./sign.js";

/** Create the connector. Keep one instance per app (export it and reuse it). */
export function sitecommand(options: SitecommandOptions = {}): Sitecommand {
  return new Sitecommand(options);
}
