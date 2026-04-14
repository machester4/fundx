import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.tsx"],
    format: ["esm"],
    target: "node20",
    clean: true,
    sourcemap: true,
    dts: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    // market-data runs in-process via createSdkMcpServer; not a stdio binary.
    entry: [
      "src/mcp/broker-local.ts",
      "src/mcp/telegram-notify.ts",
      "src/mcp/sws.ts",
      "src/mcp/screener.ts",
    ],
    format: ["esm"],
    target: "node20",
    outDir: "dist/mcp",
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
