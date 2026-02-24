import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node20",
    clean: true,
    sourcemap: true,
    dts: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: [
      "src/mcp/broker-alpaca.ts",
      "src/mcp/market-data.ts",
      "src/mcp/telegram-notify.ts",
    ],
    format: ["esm"],
    target: "node20",
    outDir: "dist/mcp",
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
