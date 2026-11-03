import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { mask } from "./mask.js";
import { readDependencies } from "./deps.js";
import { HEADER_RESPONSE_SIGNATURE, HEADER_SIGNATURE, HEADER_TIMESTAMP, NONCE_PARAM, NonceStore, responseSignature, verify } from "./sign.js";

export const VERSION = "0.1.0";

/* ---------------- types ---------------- */

export type CheckResult = { ok: boolean; status?: "ok" | "warn" | "fail"; message?: string; [key: string]: unknown };
export type HealthCheck = () => Promise<CheckResult | boolean | void> | CheckResult | boolean | void;

type FieldType = "string" | "number" | "boolean";
export type InputSpec = Record<string, FieldType | `${FieldType}?`>;

export type Action<I = Record<string, unknown>> = {
  description: string;
  /** true when the action changes data (needs "full" scope on the hub); false = read-only. */
  changes?: boolean;
  input?: InputSpec;
  /** Seconds before the action is cancelled (default 25, max 55). */
  timeout?: number;
  run: (input: I) => unknown | Promise<unknown>;
};

export type SitecommandOptions = {
  /** The site secret from Sitecommand. Default: process.env.SITECOMMAND_SECRET. */
  secret?: string;
  /** Where the routes live. Default "/api/sitecommand". */
  basePath?: string;
  /** Shown in Sitecommand. Default: npm_package_name / npm_package_version. */
  app?: { name?: string; version?: string };
  /** Your own health checks: database, cache, queue, disk… Each may take up to 5 s. */
  health?: Record<string, HealthCheck>;
  /** Named actions Sitecommand (and your AI through it) may run. Nothing else can run. */
  actions?: Record<string, Action<any>>;
  /** How many recent errors to keep in memory (default 100). */
  maxErrors?: number;
  /** Folder to look for the lockfile from (default process.cwd()). */
  root?: string;
};

export type ErrorRecord = { message: string; name: string; where: string; stack: string; count: number; first: string; last: string };

/* ---------------- the connector ---------------- */

export class Sitecommand {
  readonly basePath: string;
  framework = "node";
  private readonly nonces = new NonceStore();
  private readonly errors = new Map<string, ErrorRecord>();
  private loop: IntervalHistogram | null = null;
  private readonly started = Date.now();

  constructor(private readonly options: SitecommandOptions = {}) {
    const base = (options.basePath ?? "/api/sitecommand").replace(/\/+$/, "");
    this.basePath = base.startsWith("/") ? base : `/${base}`;
  }

  private get secret(): string | undefined {
    return this.options.secret ?? process.env.SITECOMMAND_SECRET;
  }

  /** Record a server error (adapters call this; you can too). Messages and stacks are masked. */
  captureError(error: unknown, where = ""): void {
    const e = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Unknown error");
    const message = mask(e.message, 500);
    const key = `${e.name}|${message}|${where}`;
    const now = new Date().toISOString();
    const existing = this.errors.get(key);
    if (existing) {
      existing.count++;
      existing.last = now;
      return;
    }
    const max = this.options.maxErrors ?? 100;
    if (this.errors.size >= max) {
      const oldest = [...this.errors.entries()].sort((a, b) => a[1].last.localeCompare(b[1].last))[0];
      if (oldest) this.errors.delete(oldest[0]);
    }
    this.errors.set(key, { message, name: e.name, where: mask(where, 200), stack: mask((e.stack ?? "").split("\n").slice(0, 12).join("\n"), 2000), count: 1, first: now, last: now });
  }

  /** True when the path belongs to the connector (adapters use it to pass other requests on). */
  owns(pathname: string): boolean {
    return pathname === this.basePath || pathname.startsWith(`${this.basePath}/`);
  }

  /**
   * Handle one request. Returns null when the path is not the connector's;
   * otherwise a Response. Anything not correctly signed gets a plain 404, so
   * the route does not reveal that Sitecommand is installed.
   */
  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (!this.owns(url.pathname)) return null;
    const rawBody = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    const result = verify(
      {
        secret: this.secret,
        method: request.method,
        signedPath: `${url.pathname}${url.search}`,
        rawBody,
        timestamp: request.headers.get(HEADER_TIMESTAMP),
        signature: request.headers.get(HEADER_SIGNATURE),
        nonce: url.searchParams.get(NONCE_PARAM),
      },
      this.nonces,
    );
    if (!result.ok) return notFound();

    const route = url.pathname.slice(this.basePath.length).replace(/^\/+/, "");
    let status = 200;
    let payload: unknown;
    try {
      if (request.method === "GET" && route === "info") payload = this.info();
      else if (request.method === "GET" && route === "health") payload = await this.health();
      else if (request.method === "GET" && route === "errors") payload = { ok: true, errors: [...this.errors.values()].sort((a, b) => b.last.localeCompare(a.last)) };
      else if (request.method === "GET" && route === "deps") payload = { ok: true, ...readDependencies(this.options.root) };
      else if (request.method === "GET" && route === "actions") payload = { ok: true, actions: this.listActions() };
      else if (request.method === "POST" && route.startsWith("actions/")) ({ status, payload } = await this.runAction(decodeURIComponent(route.slice("actions/".length)), rawBody));
      else {
        status = 404;
        payload = { ok: false, code: "unknown_route", message: `No connector route ${request.method} /${route}.` };
      }
    } catch (error) {
      this.captureError(error, `sitecommand ${route}`);
      status = 500;
      payload = { ok: false, code: "connector_error", message: mask(error instanceof Error ? error.message : String(error), 300) };
    }
    const body = JSON.stringify(payload);
    return new Response(body, {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store, private",
        "x-robots-tag": "noindex",
        [HEADER_RESPONSE_SIGNATURE]: responseSignature(this.secret!, result.nonce, body),
      },
    });
  }

  /* ---------------- routes ---------------- */

  info() {
    return {
      ok: true,
      connector: { name: "@sitecommand/node", version: VERSION },
      framework: this.framework,
      node: process.version,
      app: {
        name: this.options.app?.name ?? process.env.npm_package_name ?? null,
        version: this.options.app?.version ?? process.env.npm_package_version ?? null,
      },
      environment: process.env.NODE_ENV ?? null,
      platform: `${process.platform}-${process.arch}`,
      region: process.env.VERCEL_REGION ?? process.env.FLY_REGION ?? process.env.AWS_REGION ?? process.env.RAILWAY_REGION ?? null,
      host: process.env.VERCEL ? "vercel" : process.env.NETLIFY ? "netlify" : process.env.FLY_APP_NAME ? "fly" : process.env.RAILWAY_ENVIRONMENT ? "railway" : process.env.RENDER ? "render" : null,
      process_uptime_s: Math.round(process.uptime()),
      connector_uptime_s: Math.round((Date.now() - this.started) / 1000),
      health_checks: Object.keys(this.options.health ?? {}),
      actions: Object.keys(this.options.actions ?? {}),
    };
  }

  async health() {
    if (!this.loop) {
      try {
        this.loop = monitorEventLoopDelay({ resolution: 20 });
        this.loop.enable();
      } catch {
        this.loop = null;
      }
    }
    const mem = process.memoryUsage();
    const builtIn = {
      memory: { ok: true, rss_mb: Math.round(mem.rss / 1048576), heap_used_mb: Math.round(mem.heapUsed / 1048576), heap_total_mb: Math.round(mem.heapTotal / 1048576) },
      // No samples yet (the first call after start): not a failure, just not measured.
      event_loop:
        this.loop && Number.isFinite(this.loop.mean) && this.loop.count > 0
          ? { ok: this.loop.mean / 1e6 < 200, mean_ms: Math.round(this.loop.mean / 1e6), p99_ms: Math.round(this.loop.percentile(99) / 1e6) }
          : { ok: true, message: "measuring (ask again in a few seconds)" },
      process: { ok: true, uptime_s: Math.round(process.uptime()) },
    };
    const custom: Record<string, CheckResult & { ms: number }> = {};
    await Promise.all(
      Object.entries(this.options.health ?? {}).map(async ([name, check]) => {
        const started = Date.now();
        try {
          const out = await withTimeout(Promise.resolve(check()), 5000);
          const r: CheckResult = out === undefined || out === true ? { ok: true } : out === false ? { ok: false } : (out as CheckResult);
          custom[name] = { ...r, ok: !!r.ok, ...(r.message ? { message: mask(String(r.message), 300) } : {}), ms: Date.now() - started };
        } catch (error) {
          custom[name] = { ok: false, status: "fail", message: mask(error instanceof Error ? error.message : String(error), 300), ms: Date.now() - started };
        }
      }),
    );
    const all = [...Object.values(builtIn), ...Object.values(custom)];
    return { ok: all.every((c) => c.ok), checks: { ...builtIn, ...custom } };
  }

  listActions() {
    return Object.entries(this.options.actions ?? {}).map(([name, a]) => ({ name, description: a.description, changes: !!a.changes, input: a.input ?? {} }));
  }

  private async runAction(name: string, rawBody: string): Promise<{ status: number; payload: unknown }> {
    const action = this.options.actions?.[name];
    if (!action) return { status: 404, payload: { ok: false, code: "unknown_action", message: `No action named "${name}".` } };
    let body: unknown = {};
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return { status: 400, payload: { ok: false, code: "bad_json", message: "The body is not JSON." } };
    }
    const input = (body as { input?: unknown }).input ?? {};
    const checked = validateInput(action.input ?? {}, input);
    if (!checked.ok) return { status: 400, payload: { ok: false, code: "bad_input", message: checked.error } };
    const started = Date.now();
    const seconds = Math.min(Math.max(action.timeout ?? 25, 1), 55);
    try {
      const result = await withTimeout(Promise.resolve(action.run(checked.value)), seconds * 1000);
      return { status: 200, payload: { ok: true, action: name, ms: Date.now() - started, result: limitJson(result, 100_000) } };
    } catch (error) {
      this.captureError(error, `action ${name}`);
      return { status: 500, payload: { ok: false, code: "action_failed", action: name, ms: Date.now() - started, message: mask(error instanceof Error ? error.message : String(error), 500) } };
    }
  }
}

/* ---------------- helpers ---------------- */

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Check an action's input against its spec. Unknown fields are refused. Pure. */
export function validateInput(spec: InputSpec, input: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "input must be an object." };
  const value: Record<string, unknown> = {};
  const given = input as Record<string, unknown>;
  for (const key of Object.keys(given)) if (!(key in spec)) return { ok: false, error: `Unknown field "${key}".` };
  for (const [key, typeSpec] of Object.entries(spec)) {
    const optional = typeSpec.endsWith("?");
    const type = typeSpec.replace("?", "") as FieldType;
    const v = given[key];
    if (v === undefined || v === null) {
      if (!optional) return { ok: false, error: `"${key}" is required.` };
      continue;
    }
    if (typeof v !== type || (type === "number" && !Number.isFinite(v))) return { ok: false, error: `"${key}" must be a ${type}.` };
    if (type === "string" && (v as string).length > 10_000) return { ok: false, error: `"${key}" is too long.` };
    value[key] = v;
  }
  return { ok: true, value };
}

function limitJson(value: unknown, max: number): unknown {
  try {
    const s = JSON.stringify(value ?? null);
    if (s === undefined) return null;
    return s.length <= max ? JSON.parse(s) : { truncated: true, preview: s.slice(0, max) };
  } catch {
    return String(value).slice(0, max);
  }
}
