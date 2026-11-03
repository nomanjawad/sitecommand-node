import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type Dependency = { name: string; version: string; direct: boolean };
export type DependencyReport = { source: "package-lock" | "pnpm-lock" | "yarn-lock" | "bun-lock" | "installed" | "none"; dependencies: Dependency[] };

/** The nearest folder (from `start` upwards) holding a package.json. */
function findRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function directNames(root: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  } catch {
    return new Set();
  }
}

/** package-lock.json v2/v3. Pure. */
export function fromPackageLock(json: string, direct: Set<string>): Dependency[] {
  const lock = JSON.parse(json) as { packages?: Record<string, { version?: string; link?: boolean }> };
  const out = new Map<string, Dependency>();
  for (const [path, info] of Object.entries(lock.packages ?? {})) {
    // Only installed packages: the root ("") and linked local folders are not dependencies.
    if (!path || !info.version || info.link || !path.includes("node_modules/")) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!name) continue;
    out.set(`${name}@${info.version}`, { name, version: info.version, direct: direct.has(name) && !path.includes("node_modules/", path.indexOf("node_modules/") + 1) });
  }
  return [...out.values()];
}

/** pnpm-lock.yaml (v6–v9) package keys like `/name@1.2.3` or `name@1.2.3(peer)`. Pure. */
export function fromPnpmLock(yaml: string, direct: Set<string>): Dependency[] {
  const out = new Map<string, Dependency>();
  const section = yaml.split(/\n(?=packages:\s*\n)/)[1] ?? "";
  for (const m of section.matchAll(/^\s{2}['"]?\/?((?:@[^/\s'"]+\/)?[^@\s'"/]+)@([0-9][^(:\s'"]*)/gm)) {
    const name = m[1]!;
    const version = m[2]!;
    out.set(`${name}@${version}`, { name, version, direct: direct.has(name) });
  }
  return [...out.values()];
}

/** yarn.lock (v1 and berry). Pure. */
export function fromYarnLock(text: string, direct: Set<string>): Dependency[] {
  const out = new Map<string, Dependency>();
  const blocks = text.split(/\n(?=\S)/);
  for (const block of blocks) {
    const header = block.split("\n")[0] ?? "";
    const nameMatch = /^"?((?:@[^/@\s"]+\/)?[^@\s",]+)@/.exec(header);
    const versionMatch = /\n\s+version:?\s+"?([^"\s]+)"?/.exec(block);
    if (!nameMatch || !versionMatch) continue;
    const name = nameMatch[1]!;
    out.set(`${name}@${versionMatch[1]}`, { name, version: versionMatch[1]!, direct: direct.has(name) });
  }
  return [...out.values()];
}

/** Installed versions of the direct dependencies (works when the lockfile is not deployed, e.g. serverless). */
function fromInstalled(root: string, direct: Set<string>): Dependency[] {
  const req = createRequire(join(root, "package.json"));
  const out: Dependency[] = [];
  for (const name of direct) {
    try {
      const pkgPath = req.resolve(`${name}/package.json`);
      const v = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version;
      if (v) out.push({ name, version: v, direct: true });
    } catch {
      // package not resolvable from here (exports map without package.json): skip
    }
  }
  return out;
}

let cached: { at: number; report: DependencyReport } | null = null;

export function readDependencies(start = process.cwd(), maxAgeMs = 10 * 60_000): DependencyReport {
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.report;
  const root = findRoot(start);
  let report: DependencyReport = { source: "none", dependencies: [] };
  if (root) {
    const direct = directNames(root);
    const tries: [DependencyReport["source"], string, (s: string, d: Set<string>) => Dependency[]][] = [
      ["package-lock", "package-lock.json", fromPackageLock],
      ["pnpm-lock", "pnpm-lock.yaml", fromPnpmLock],
      ["yarn-lock", "yarn.lock", fromYarnLock],
    ];
    for (let dir: string | null = root, i = 0; dir && i < 4 && report.source === "none"; i++) {
      for (const [source, file, parse] of tries) {
        const p = join(dir, file);
        if (!existsSync(p)) continue;
        try {
          const deps = parse(readFileSync(p, "utf8"), direct);
          if (deps.length) {
            report = { source, dependencies: deps };
            break;
          }
        } catch {
          // unreadable lockfile: try the next
        }
      }
      const up = dirname(dir);
      dir = up === dir ? null : up;
    }
    if (report.source === "none") {
      const installed = fromInstalled(root, direct);
      if (installed.length) report = { source: "installed", dependencies: installed };
    }
  }
  report.dependencies.sort((a, b) => a.name.localeCompare(b.name));
  cached = { at: Date.now(), report };
  return report;
}
