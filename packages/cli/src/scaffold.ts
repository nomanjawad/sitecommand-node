import { dirname, join, relative } from "node:path";
import type { Project } from "./detect.js";

export type PlannedFile = { path: string; content: string };
export type Plan = { files: PlannedFile[]; /** Lines the developer adds to their own entry file (never edited for them). */ instructions: string[] };

function importPath(fromFile: string, toFileNoExt: string): string {
  let p = relative(dirname(fromFile), toFileNoExt).split("\\").join("/");
  if (!p.startsWith(".")) p = `./${p}`;
  return p;
}

/** The files to create for this project, and what to add by hand. Pure. */
export function planFiles(project: Project, basePath = "/api/sitecommand"): Plan {
  const ext = project.typescript ? "ts" : "js";
  const scFile = join(project.codeDir, `sitecommand.${ext}`);
  const scNoExt = join(project.codeDir, "sitecommand");
  const baseOption = basePath === "/api/sitecommand" ? "" : `\n  basePath: ${JSON.stringify(basePath)},`;
  const esmImport = project.esm || project.typescript;
  const setup = esmImport
    ? `import { sitecommand } from "@sitecommand/node";

/**
 * Sitecommand connector. Only what you register here can be read or run.
 * Docs: https://github.com/nomanjawad/sitecommand-node#readme
 */
export const sc = sitecommand({${baseOption}
  health: {
    // database: async () => { await db.query("select 1"); return true; },
  },
  actions: {
    // "clear-cache": { description: "Clear the cache", changes: true, run: () => cache.clear() },
  },
});
`
    : `const { sitecommand } = require("@sitecommand/node");

/** Sitecommand connector. Only what you register here can be read or run. */
const sc = sitecommand({${baseOption}
  health: {},
  actions: {},
});

module.exports = { sc };
`;
  const files: PlannedFile[] = [{ path: scFile, content: setup }];
  const instructions: string[] = [];
  const jsSuffix = project.esm && !project.typescript ? ".js" : "";

  switch (project.framework) {
    case "nextjs": {
      const segments = basePath.replace(/^\/+/, "").split("/");
      const routeFile = join(project.nextAppDir ?? "app", ...segments, "[...path]", `route.${ext}`);
      files.push({
        path: routeFile,
        content: `import { sc } from "${importPath(routeFile, scNoExt)}";
import { routeHandlers } from "@sitecommand/node/next";

export const { GET, POST } = routeHandlers(sc);
export const dynamic = "force-dynamic";
`,
      });
      const instr = join(project.codeDir === "src" ? "src" : ".", `instrumentation.${ext}`);
      files.push({
        path: instr,
        content: `import { sc } from "${importPath(instr, scNoExt)}";
import { recordRequestErrors } from "@sitecommand/node/next";

// Records server errors for Sitecommand (secrets are masked).
export const onRequestError = recordRequestErrors(sc);
`,
      });
      break;
    }
    case "express":
      instructions.push(
        esmImport ? `import { sitecommandExpress, sitecommandErrors } from "@sitecommand/node/express";` : `const { sitecommandExpress, sitecommandErrors } = require("@sitecommand/node/express");`,
        esmImport ? `import { sc } from "${importPath("x", scNoExt)}${jsSuffix}";` : `const { sc } = require("./sitecommand");`,
        `app.use(sitecommandExpress(sc));   // before express.json() and your routes`,
        `app.use(sitecommandErrors(sc));    // after your routes`,
      );
      break;
    case "fastify":
      instructions.push(
        esmImport ? `import { sitecommandFastify } from "@sitecommand/node/fastify";` : `const { sitecommandFastify } = require("@sitecommand/node/fastify");`,
        esmImport ? `import { sc } from "${importPath("x", scNoExt)}${jsSuffix}";` : `const { sc } = require("./sitecommand");`,
        `await app.register(sitecommandFastify(sc));`,
      );
      break;
    case "nestjs":
      instructions.push(`import { useSitecommand } from "@sitecommand/node/nest";`, `import { sc } from "./sitecommand";`, `useSitecommand(app, sc);   // in main.ts, before app.listen()`);
      break;
    case "hono":
      instructions.push(
        `import { sitecommandHono } from "@sitecommand/node/hono";`,
        `import { sc } from "${importPath("x", scNoExt)}${jsSuffix}";`,
        `app.use("*", sitecommandHono(sc));`,
      );
      break;
    default:
      instructions.push(
        esmImport ? `import { nodeHandler } from "@sitecommand/node/http";` : `const { nodeHandler } = require("@sitecommand/node/http");`,
        esmImport ? `import { sc } from "${importPath("x", scNoExt)}${jsSuffix}";` : `const { sc } = require("./sitecommand");`,
        `const handle = nodeHandler(sc);`,
        `// first line of your request handler:`,
        `if (await handle(req, res)) return;`,
      );
  }
  return { files, instructions };
}

/** Add or replace KEY=value lines in an env file's text. Pure. */
export function upsertEnv(text: string, values: Record<string, string>): string {
  const lines = text.split(/\r?\n/);
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = line;
    else {
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(line, "");
    }
  }
  return lines.join("\n").replace(/\n*$/, "\n");
}

/** Whether a .gitignore already ignores this file (simple patterns). Pure. */
export function gitignoreCovers(text: string, file: string): boolean {
  return text.split(/\r?\n/).some((l) => {
    const p = l.trim();
    if (p === file || p === `/${file}` || p === ".env*") return true;
    if (p === ".env.*") return file !== ".env";
    if (p === ".env*.local") return file.endsWith(".local");
    return false;
  });
}
