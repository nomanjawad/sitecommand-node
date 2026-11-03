# @sitecommand/node

Connect a Node app to [Sitecommand](https://siteconnector.vercel.app): server health, recent server errors, dependency versions (checked for known vulnerabilities by the hub) and the actions **you** choose to expose — for your dashboard and for your AI assistant through Sitecommand.

- **Read-only by design.** It never runs arbitrary code, writes files, runs shell commands or reads your environment. The only things that can run are the actions you register.
- **Signed requests only.** Every request is signed with your site secret (HMAC-SHA256, ±5 minutes, single-use nonce). Anything else gets a plain `404`, so the route does not even reveal it exists. Every answer is signed back, so nothing in between can fake it.
- **Zero dependencies.** Only `node:crypto`.

## Install

The easy way (detects your framework, signs you in with a code, adds the route and the secret):

```bash
npx sitecommand connect
```

Or by hand: `npm i @sitecommand/node`, add the route for your framework below, set `SITECOMMAND_SECRET` (shown once in the Sitecommand dashboard) in your hosting's environment, deploy, and press **Verify**.

## Create the connector

```ts
// sitecommand.ts
import { sitecommand } from "@sitecommand/node";

export const sc = sitecommand({
  health: {
    database: async () => { await db.query("select 1"); return true; },
    redis: async () => ({ ok: (await redis.ping()) === "PONG" }),
  },
  actions: {
    "clear-cache": { description: "Clear the page cache", changes: true, run: () => cache.clear() },
    "recent-signups": { description: "Latest sign-ups", input: { limit: "number?" }, run: ({ limit = 20 }) => users.latest(limit) },
  },
});
```

## Mount it

**Next.js (App Router)** — `app/api/sitecommand/[...path]/route.ts`:
```ts
import { sc } from "@/sitecommand";
import { routeHandlers } from "@sitecommand/node/next";
export const { GET, POST } = routeHandlers(sc);
export const dynamic = "force-dynamic";
```
Record server errors in `instrumentation.ts`: `export const onRequestError = recordRequestErrors(sc);` (from `@sitecommand/node/next`).

**Express** — before your body parsers:
```ts
import { sitecommandExpress, sitecommandErrors } from "@sitecommand/node/express";
app.use(sitecommandExpress(sc));
// …your routes…
app.use(sitecommandErrors(sc));
```

**Fastify**
```ts
import { sitecommandFastify } from "@sitecommand/node/fastify";
await app.register(sitecommandFastify(sc));
```

**NestJS** — in `main.ts`, before `app.listen()`:
```ts
import { useSitecommand } from "@sitecommand/node/nest";
useSitecommand(app, sc);
```

**Hono, Bun, Deno, Remix, SvelteKit, any Fetch server**
```ts
import { sitecommandHono } from "@sitecommand/node/hono";
app.use("*", sitecommandHono(sc));
// or anywhere: const response = await sc.handle(request); // null = not the connector's path
```

**Plain `node:http`**
```ts
import { nodeHandler } from "@sitecommand/node/http";
const handle = nodeHandler(sc);
http.createServer(async (req, res) => { if (await handle(req, res)) return; /* your app */ });
```

## Routes (all under `/api/sitecommand`, all signed)

| Route | What it returns |
|---|---|
| `GET /info` | connector, Node, framework, app name and version, environment, host, region |
| `GET /health` | memory, event-loop delay, process uptime, and your checks (each up to 5 s) |
| `GET /errors` | recent server errors (deduplicated, secrets masked) |
| `GET /deps` | dependency versions from your lockfile (or installed packages) |
| `GET /actions` | the actions you registered |
| `POST /actions/:name` | runs one action with validated input (time limit 25 s by default) |

Options: `secret` (default `process.env.SITECOMMAND_SECRET`), `basePath` (default `/api/sitecommand`), `app`, `health`, `actions`, `maxErrors`, `root`.

## Security notes

- Keep `SITECOMMAND_SECRET` in your hosting's environment, never in git.
- Actions marked `changes: true` can only be run by people and AI connections with full access on your Sitecommand account.
- Error messages and health messages are masked for passwords, tokens, keys, emails and connection strings before they leave the app.

MIT licence.
