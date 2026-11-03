import { describe, expect, it } from "vitest";
import { fromPackageLock, fromPnpmLock, fromYarnLock } from "../src/deps";

describe("lockfile parsers", () => {
  it("package-lock v3", () => {
    const lock = JSON.stringify({ packages: { "": { name: "app" }, "node_modules/next": { version: "15.5.0" }, "node_modules/@scope/x": { version: "1.0.0" }, "node_modules/next/node_modules/react": { version: "19.0.0" } } });
    const deps = fromPackageLock(lock, new Set(["next"]));
    expect(deps).toContainEqual({ name: "next", version: "15.5.0", direct: true });
    expect(deps).toContainEqual({ name: "@scope/x", version: "1.0.0", direct: false });
    expect(deps).toContainEqual({ name: "react", version: "19.0.0", direct: false });
  });
  it("pnpm-lock v9", () => {
    const yaml = "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies: {}\n\npackages:\n\n  next@15.5.0:\n    resolution: {}\n\n  '@scope/x@1.0.0':\n    resolution: {}\n\n  react@19.0.0(peer@1.0.0):\n    resolution: {}\n";
    const deps = fromPnpmLock(yaml, new Set(["next"]));
    expect(deps).toContainEqual({ name: "next", version: "15.5.0", direct: true });
    expect(deps).toContainEqual({ name: "@scope/x", version: "1.0.0", direct: false });
    expect(deps).toContainEqual({ name: "react", version: "19.0.0", direct: false });
  });
  it("yarn.lock v1", () => {
    const text = '# yarn lockfile v1\n\n"@scope/x@^1.0.0":\n  version "1.0.2"\n\nnext@^15.0.0, next@^15.5.0:\n  version "15.5.0"\n';
    const deps = fromYarnLock(text, new Set(["next"]));
    expect(deps).toContainEqual({ name: "@scope/x", version: "1.0.2", direct: false });
    expect(deps).toContainEqual({ name: "next", version: "15.5.0", direct: true });
  });
});
