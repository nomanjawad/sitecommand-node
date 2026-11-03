import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/next": "src/adapters/next.ts",
    "adapters/express": "src/adapters/express.ts",
    "adapters/fastify": "src/adapters/fastify.ts",
    "adapters/hono": "src/adapters/hono.ts",
    "adapters/nest": "src/adapters/nest.ts",
    "adapters/http": "src/adapters/http.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "node20",
  splitting: false,
  sourcemap: false,
});
