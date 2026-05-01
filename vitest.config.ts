import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Node-env Vitest config for the n8n node package. Coverage thresholds
// mirror apps/web (80 / 80 — standards Principle V).
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        lines: 80,
        branches: 80,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
