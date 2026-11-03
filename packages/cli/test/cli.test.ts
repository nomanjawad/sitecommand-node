import { describe, expect, it } from "vitest";
import { frameworkOf, installCommand, packageManagerAt } from "../src/detect";
import { gitignoreCovers, planFiles, upsertEnv } from "../src/scaffold";
import type { Project } from "../src/detect";

const base: Project = { root: "/app", name: "demo", framework: "nextjs", typescript: true, esm: true, packageManager: "pnpm", nextAppDir: "app", codeDir: ".", hasConnector: false };

describe("detect", () => {
  it("picks the most specific framework", () => {
    expect(frameworkOf({ next: "15", react: "19" })).toBe("nextjs");
    expect(frameworkOf({ "@nestjs/core": "11", express: "5" })).toBe("nestjs");
    expect(frameworkOf({ fastify: "5" })).toBe("fastify");
    expect(frameworkOf({ hono: "4" })).toBe("hono");
    expect(frameworkOf({ express: "5" })).toBe("express");
    expect(frameworkOf({})).toBe("node");
  });
  it("finds the package manager from the lockfile, also one folder up", () => {
    expect(packageManagerAt("/a/app", (p) => p === "/a/app/yarn.lock")).toBe("yarn");
    expect(packageManagerAt("/a/app", (p) => p === "/a/pnpm-lock.yaml")).toBe("pnpm");
    expect(packageManagerAt("/a/app", () => false)).toBe("npm");
    expect(installCommand("pnpm", "@sitecommand/node")).toEqual(["pnpm", "add", "@sitecommand/node"]);
  });
});

describe("scaffold", () => {
  it("Next.js: setup file, route file and instrumentation with correct relative imports", () => {
    const plan = planFiles(base);
    expect(plan.files.map((f) => f.path)).toEqual(["sitecommand.ts", "app/api/sitecommand/[...path]/route.ts", "instrumentation.ts"]);
    expect(plan.files[1]!.content).toContain('from "../../../../sitecommand"');
    expect(plan.files[1]!.content).toContain("export const dynamic");
    expect(plan.files[2]!.content).toContain('from "./sitecommand"');
  });
  it("Next.js with src/app and a custom base path", () => {
    const plan = planFiles({ ...base, nextAppDir: "src/app", codeDir: "src" }, "/internal/sc");
    expect(plan.files.map((f) => f.path)).toEqual(["src/sitecommand.ts", "src/app/internal/sc/[...path]/route.ts", "src/instrumentation.ts"]);
    expect(plan.files[0]!.content).toContain('basePath: "/internal/sc"');
    expect(plan.files[1]!.content).toContain('from "../../../../sitecommand"');
  });
  it("Express in CommonJS: require syntax and instructions, never edits the entry file", () => {
    const plan = planFiles({ ...base, framework: "express", typescript: false, esm: false, nextAppDir: null });
    expect(plan.files.map((f) => f.path)).toEqual(["sitecommand.js"]);
    expect(plan.files[0]!.content).toContain("require(\"@sitecommand/node\")");
    expect(plan.instructions.join("\n")).toContain("app.use(sitecommandExpress(sc))");
  });
  it("env and gitignore", () => {
    expect(upsertEnv("A=1\n", { SITECOMMAND_SECRET: "x" })).toBe("A=1\nSITECOMMAND_SECRET=x\n");
    expect(upsertEnv("SITECOMMAND_SECRET=old\nB=2\n", { SITECOMMAND_SECRET: "new" })).toBe("SITECOMMAND_SECRET=new\nB=2\n");
    expect(gitignoreCovers("node_modules\n.env*.local\n", ".env.local")).toBe(true);
    expect(gitignoreCovers("node_modules\n.env*.local\n", ".env")).toBe(false);
    expect(gitignoreCovers(".env\n", ".env")).toBe(true);
  });
});
