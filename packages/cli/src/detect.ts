import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Framework = "nextjs" | "express" | "fastify" | "nestjs" | "hono" | "node";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type Project = {
  root: string;
  name: string | null;
  framework: Framework;
  typescript: boolean;
  esm: boolean;
  packageManager: PackageManager;
  /** Next.js: the app directory ("app" or "src/app"); others: null. */
  nextAppDir: string | null;
  /** Folder for sitecommand.ts ("src" when the project uses one, else the root). */
  codeDir: string;
  hasConnector: boolean;
};

type PackageJson = { name?: string; type?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

/** Which framework the dependencies point to (most specific first). Pure. */
export function frameworkOf(deps: Record<string, string>): Framework {
  if (deps.next) return "nextjs";
  if (deps["@nestjs/core"]) return "nestjs";
  if (deps.fastify) return "fastify";
  if (deps.hono) return "hono";
  if (deps.express) return "express";
  return "node";
}

/** The package manager from the lockfile in this folder or one above (monorepos). Pure apart from the file checks. */
export function packageManagerAt(root: string, exists: (p: string) => boolean = existsSync): PackageManager {
  for (const dir of [root, join(root, ".."), join(root, "..", "..")]) {
    if (exists(join(dir, "pnpm-lock.yaml"))) return "pnpm";
    if (exists(join(dir, "yarn.lock"))) return "yarn";
    if (exists(join(dir, "bun.lockb")) || exists(join(dir, "bun.lock"))) return "bun";
    if (exists(join(dir, "package-lock.json"))) return "npm";
  }
  return "npm";
}

export function installCommand(pm: PackageManager, spec: string): string[] {
  if (pm === "npm") return ["npm", "install", spec];
  if (pm === "yarn") return ["yarn", "add", spec];
  if (pm === "bun") return ["bun", "add", spec];
  return ["pnpm", "add", spec];
}

export function detectProject(root: string): Project | null {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
  } catch {
    return null;
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const framework = frameworkOf(deps);
  const typescript = existsSync(join(root, "tsconfig.json")) || !!deps.typescript;
  const nextAppDir = framework === "nextjs" ? (existsSync(join(root, "src", "app")) ? "src/app" : existsSync(join(root, "app")) ? "app" : "app") : null;
  const codeDir = existsSync(join(root, "src")) ? "src" : ".";
  return {
    root,
    name: pkg.name ?? null,
    framework,
    typescript,
    esm: pkg.type === "module" || framework === "nextjs",
    packageManager: packageManagerAt(root),
    nextAppDir,
    codeDir,
    hasConnector: !!deps["@sitecommand/node"],
  };
}

export const FRAMEWORK_NAMES: Record<Framework, string> = { nextjs: "Next.js", express: "Express", fastify: "Fastify", nestjs: "NestJS", hono: "Hono", node: "Node (node:http)" };
