// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/integration/**", "node_modules/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          poolOptions: {
            threads: { singleThread: true },
          },
          testTimeout: 30_000,
        },
      },
    ],
  },
});
