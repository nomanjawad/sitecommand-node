import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit, env, platform, cwd } from "node:process";
import { detectProject, installCommand, FRAMEWORK_NAMES, type Project } from "./detect.js";
import { gitignoreCovers, planFiles, upsertEnv } from "./scaffold.js";
import { localInfo, pollDevice, remoteVerify, startDevice, type VerifyReport } from "./hub.js";

const VERSION = "0.1.0";
const DEFAULT_HUB = "https://siteconnector.vercel.app";
const STATE_FILE = ".sitecommand.json";

type State = { hub: string; site_id: string; site_url: string; base_path: string; env_file: string };

const color = (code: number) => (s: string) => (stdout.isTTY && !env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = color(32);
const red = color(31);
const yellow = color(33);
const dim = color(2);
const bold = color(1);
const ok = (s: string) => console.log(`${green("✓")} ${s}`);
const bad = (s: string) => console.log(`${red("✗")} ${s}`);
const info = (s: string) => console.log(`${dim("·")} ${s}`);

/* ---------------- args ---------------- */

function parseArgs(args: string[]): { command: string; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  let command = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k!] = v;
      else if (args[i + 1] && !args[i + 1]!.startsWith("--")) flags[k!] = args[++i]!;
      else flags[k!] = true;
    } else if (!command) command = a;
  }
  return { command: command || "help", flags };
}

const { command, flags } = parseArgs(argv.slice(2));
const root = typeof flags.cwd === "string" ? flags.cwd : cwd();
const yes = flags.yes === true || flags.y === true;
const hubFlag = typeof flags.hub === "string" ? flags.hub.replace(/\/+$/, "") : null;

/* ---------------- helpers ---------------- */

async function ask(question: string, fallback = ""): Promise<string> {
  if (!stdin.isTTY) return fallback;
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(`${question}${fallback ? dim(` (${fallback})`) : ""} `)).trim();
  rl.close();
  return answer || fallback;
}

async function confirm(question: string, def = true): Promise<boolean> {
  if (yes || !stdin.isTTY) return def;
  const a = (await ask(`${question} ${dim(def ? "[Y/n]" : "[y/N]")}`)).toLowerCase();
  return a ? a.startsWith("y") : def;
}

function openBrowser(url: string): void {
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // no browser: the link is printed anyway
  }
}

function readState(): State | null {
  try {
    return JSON.parse(readFileSync(join(root, STATE_FILE), "utf8")) as State;
  } catch {
    return null;
  }
}

function readEnvSecret(state: State | null): string | null {
  if (env.SITECOMMAND_SECRET) return env.SITECOMMAND_SECRET;
  for (const f of [state?.env_file, ".env.local", ".env"].filter(Boolean) as string[]) {
    try {
      const m = /^SITECOMMAND_SECRET=(.+)$/m.exec(readFileSync(join(root, f), "utf8"));
      if (m) return m[1]!.trim().replace(/^["']|["']$/g, "");
    } catch {
      // next
    }
  }
  return null;
}

function printReport(report: VerifyReport): void {
  for (const s of report.steps) {
    if (s.ok) ok(`${bold(s.label)} ${dim(s.detail)}`);
    else {
      bad(`${bold(s.label)} ${s.detail}`);
      if (s.fix) console.log(`    ${yellow("fix:")} ${s.fix}`);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------- commands ---------------- */

async function connect(): Promise<number> {
  console.log(bold(`\nSitecommand connect ${dim(`v${VERSION}`)}\n`));
  const project = detectProject(root);
  if (!project) {
    bad("No package.json here. Run this in your Node app's folder (or pass --cwd).");
    return 1;
  }
  ok(`Found ${bold(FRAMEWORK_NAMES[project.framework])} ${dim(`(${project.typescript ? "TypeScript" : "JavaScript"}, ${project.packageManager})`)}${project.name ? ` · ${project.name}` : ""}`);
  if (project.framework === "node") info("No known framework found: using the plain node:http adapter. Pass --framework to choose one.");
  if (typeof flags.framework === "string") (project as Project).framework = flags.framework as Project["framework"];

  const hub = hubFlag ?? env.SITECOMMAND_HUB ?? DEFAULT_HUB;
  const basePath = typeof flags["base-path"] === "string" ? `/${flags["base-path"].replace(/^\/+|\/+$/g, "")}` : "/api/sitecommand";
  let siteUrl = typeof flags.url === "string" ? flags.url : await ask("Where is the app live? (its https:// address)");
  if (!siteUrl) {
    bad("The app's address is needed: run again with --url https://your-app.example.com");
    return 1;
  }
  if (!/^https?:\/\//.test(siteUrl)) siteUrl = `https://${siteUrl}`;

  // 1. Sign in with a code
  let start;
  try {
    start = await startDevice(hub, { site_url: siteUrl, framework: project.framework, app_name: project.name, base_path: basePath });
  } catch (e) {
    bad(`Could not reach Sitecommand at ${hub}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  console.log(`\n  Your code: ${bold(start.user_code)}\n  Approve it at ${start.verification_uri_complete}\n`);
  if (!flags["no-browser"]) openBrowser(start.verification_uri_complete);
  info("Waiting for approval in the browser…");
  const deadline = Date.now() + start.expires_in * 1000;
  let approved: Extract<Awaited<ReturnType<typeof pollDevice>>, { status: "approved" }> | null = null;
  while (Date.now() < deadline) {
    await sleep(start.interval * 1000);
    const p = await pollDevice(hub, start.device_code).catch(() => ({ status: "pending" as const }));
    if (p.status === "approved") {
      approved = p;
      break;
    }
    if (p.status === "denied") {
      bad("The connection was denied in the browser.");
      return 1;
    }
    if (p.status === "expired" || p.status === "unknown") {
      bad("The code expired. Run npx sitecommand connect again.");
      return 1;
    }
  }
  if (!approved) {
    bad("Timed out waiting for approval.");
    return 1;
  }
  ok(`Approved: ${approved.site_url} is connected to your Sitecommand account (waiting for Verify).`);

  // 2. Install the package
  if (!project.hasConnector || flags.package) {
    const spec = typeof flags.package === "string" ? flags.package : "@sitecommand/node";
    const [cmd, ...args] = installCommand(project.packageManager, spec);
    info(`Installing ${spec} with ${project.packageManager}…`);
    const res = spawnSync(cmd!, args, { cwd: root, stdio: "inherit", shell: platform === "win32" });
    if (res.status !== 0) {
      bad(`Install failed. Run it yourself: ${[cmd, ...args].join(" ")}`);
    } else ok(`Installed ${spec}`);
  } else ok("@sitecommand/node is already installed");

  // 3. Route files
  const plan = planFiles(project, approved.base_path);
  for (const f of plan.files) {
    const full = join(root, f.path);
    if (existsSync(full)) {
      info(`${f.path} already exists: left as it is.${f.path.includes("instrumentation") ? " Add onRequestError = recordRequestErrors(sc) to it to record server errors." : ""}`);
      continue;
    }
    if (!(await confirm(`Create ${bold(f.path)}?`))) continue;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
    ok(`Created ${f.path}`);
  }
  if (plan.instructions.length) {
    console.log(`\n  Add these lines to your app's entry file:\n`);
    for (const l of plan.instructions) console.log(`    ${l}`);
    console.log("");
  }

  // 4. The secret
  const envFile = project.framework === "nextjs" ? ".env.local" : ".env";
  const envPath = join(root, envFile);
  const before = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  writeFileSync(envPath, upsertEnv(before, { SITECOMMAND_SECRET: approved.site_secret, SITECOMMAND_HUB: hub }));
  ok(`Saved SITECOMMAND_SECRET in ${envFile}`);
  const giPath = join(root, ".gitignore");
  const gi = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  if (!gitignoreCovers(gi, envFile)) {
    writeFileSync(giPath, `${gi.replace(/\n*$/, "\n")}${envFile}\n`);
    ok(`Added ${envFile} to .gitignore`);
  }
  writeFileSync(join(root, STATE_FILE), `${JSON.stringify({ hub, site_id: approved.site_id, site_url: approved.site_url, base_path: approved.base_path, env_file: envFile } satisfies State, null, 2)}\n`);
  ok(`Saved ${STATE_FILE} (no secrets in it; fine to commit)`);

  // 5. The hosting's environment
  const hasVercel = existsSync(join(root, ".vercel")) && spawnSync("vercel", ["--version"], { stdio: "ignore", shell: platform === "win32" }).status === 0;
  if (hasVercel && (await confirm("Add SITECOMMAND_SECRET to your Vercel project (production) now?"))) {
    for (const [k, v] of [["SITECOMMAND_SECRET", approved.site_secret], ["SITECOMMAND_HUB", hub]] as const) {
      const r = spawnSync("vercel", ["env", "add", k, "production"], { cwd: root, input: `${v}\n`, stdio: ["pipe", "inherit", "inherit"], shell: platform === "win32" });
      if (r.status === 0) ok(`Vercel: ${k} added`);
      else bad(`Vercel: could not add ${k}; add it in the Vercel dashboard`);
    }
  } else {
    console.log(`\n  ${bold("Add these two variables to your hosting's environment")} ${dim("(Vercel, Netlify, Railway, Render, Fly…)")}:`);
    console.log(`    SITECOMMAND_SECRET=${dim("(the value in " + envFile + ")")}`);
    console.log(`    SITECOMMAND_HUB=${hub}`);
  }

  console.log(`\n${bold("Last step:")} deploy the app, then run ${bold("npx sitecommand verify")}`);
  console.log(dim(`Running it locally first? Start your dev server and run npx sitecommand check --url http://localhost:3000\n`));
  return 0;
}

async function verify(): Promise<number> {
  const state = readState();
  if (!state) {
    bad(`No ${STATE_FILE} here: run npx sitecommand connect first (or Verify from the dashboard).`);
    return 1;
  }
  const secret = readEnvSecret(state);
  if (!secret) {
    bad(`SITECOMMAND_SECRET not found in ${state.env_file} or the environment.`);
    return 1;
  }
  info(`Asking Sitecommand to check ${state.site_url}${state.base_path}…`);
  const { status, report } = await remoteVerify(hubFlag ?? state.hub, state.site_id, secret);
  if (!report) {
    bad(status === 404 ? "Sitecommand does not know this app with this secret (removed from the dashboard, or the secret changed)." : `The hub answered ${status}.`);
    return 1;
  }
  printReport(report);
  console.log(report.ok ? `\n${green(bold("Connected."))} Health, errors, dependencies and actions now show in Sitecommand.\n` : `\n${yellow("Not connected yet.")} Fix the red lines, deploy, and run verify again.\n`);
  return report.ok ? 0 : 1;
}

async function check(): Promise<number> {
  const state = readState();
  const secret = readEnvSecret(state);
  const base = typeof flags.url === "string" ? `${flags.url.replace(/\/+$/, "")}${state?.base_path ?? "/api/sitecommand"}` : null;
  if (!base) {
    bad("Pass the running app's address: npx sitecommand check --url http://localhost:3000");
    return 1;
  }
  if (!secret) {
    bad("SITECOMMAND_SECRET not found (.env.local, .env or the environment).");
    return 1;
  }
  const r = await localInfo(base, secret);
  if (r.ok) {
    const i = JSON.parse(r.body) as { framework?: string; node?: string; connector?: { version?: string } };
    ok(`The connector answers at ${base} (${i.framework}, Node ${i.node}, @sitecommand/node ${i.connector?.version}) and signs its replies.`);
    return 0;
  }
  bad(r.status === 404 ? `404 at ${base}: the route is missing, or the app does not have this SITECOMMAND_SECRET (restart the dev server after editing .env).` : r.status === 0 ? `Could not reach ${base}: ${r.body}` : `Answered ${r.status} without the connector's signature: something else handles this path.`);
  return 1;
}

async function doctor(): Promise<number> {
  const project = detectProject(root);
  const state = readState();
  let fails = 0;
  const line = (good: boolean, label: string, fix: string) => {
    if (good) ok(label);
    else {
      fails++;
      bad(`${label} ${yellow("→")} ${fix}`);
    }
  };
  line(!!project, "package.json found", "run in the app's folder");
  if (project) {
    line(project.hasConnector, "@sitecommand/node installed", `${installCommand(project.packageManager, "@sitecommand/node").join(" ")}`);
    const plan = planFiles(project, state?.base_path);
    for (const f of plan.files.filter((x) => !x.path.includes("instrumentation"))) line(existsSync(join(root, f.path)), `${f.path} exists`, "run npx sitecommand connect, or create it from the README");
  }
  line(!!state, `${STATE_FILE} found`, "run npx sitecommand connect");
  line(!!readEnvSecret(state), "SITECOMMAND_SECRET set locally", "connect again, or copy it from where you saved it");
  if (fails === 0 && state) return verify();
  return fails ? 1 : 0;
}

function status(): number {
  const state = readState();
  if (!state) {
    info("Not connected yet: npx sitecommand connect");
    return 1;
  }
  console.log(`  App      ${state.site_url}\n  Route    ${state.base_path}\n  Hub      ${state.hub}\n  Site id  ${state.site_id}\n  Secret   ${readEnvSecret(state) ? green("set") : red("missing")} (${state.env_file})`);
  return 0;
}

function help(): number {
  console.log(`
${bold("sitecommand")} ${dim(`v${VERSION}`)} — connect a Node app to Sitecommand

  ${bold("npx sitecommand connect")}   find the framework, approve a code in the browser, install
                            @sitecommand/node, add the route and save the secret
  ${bold("npx sitecommand verify")}    after deploying: Sitecommand checks the live app
  ${bold("npx sitecommand check")} --url http://localhost:3000   test a local dev server
  ${bold("npx sitecommand doctor")}    find and explain what is missing
  ${bold("npx sitecommand status")}    show what is connected

  Options: --url <address>  --hub <hub url>  --framework nextjs|express|fastify|nestjs|hono|node
           --base-path /api/sitecommand  --yes  --no-browser  --cwd <folder>
`);
  return 0;
}

const commands: Record<string, () => Promise<number> | number> = { connect, verify, check, doctor, status, help, "--help": help, "-h": help, version: () => (console.log(VERSION), 0), "--version": () => (console.log(VERSION), 0) };
const run = commands[command];
if (!run) {
  bad(`Unknown command "${command}".`);
  help();
  exit(1);
}
Promise.resolve(run()).then(
  (code) => exit(code),
  (e) => {
    bad(e instanceof Error ? e.message : String(e));
    exit(1);
  },
);
