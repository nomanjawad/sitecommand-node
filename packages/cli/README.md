# sitecommand

Connect a Node app to [Sitecommand](https://github.com/nomanjawad/sitecommand-node) in one command:

```bash
npx sitecommand connect
```

It finds your framework (Next.js, Express, Fastify, NestJS, Hono or plain Node), shows a code you approve in the browser, installs [`@sitecommand/node`](https://www.npmjs.com/package/@sitecommand/node), adds the route, saves the secret to `.env.local` / `.env` (and makes sure git ignores it), and offers to set it on Vercel. Then deploy and run:

```bash
npx sitecommand verify
```

Other commands: `check --url http://localhost:3000` (test a local dev server), `doctor` (find and explain what is missing), `status`.

Options: `--url`, `--hub`, `--framework`, `--base-path`, `--yes`, `--no-browser`, `--cwd`.

No dependencies; nothing is sent anywhere except to your Sitecommand hub. MIT licence.
