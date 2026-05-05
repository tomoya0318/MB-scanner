import { defineConfig } from "vitest/config";

// 判断: ../ai-guide/adr/0007-in-source-testing-internal-helpers.md
export default defineConfig({
  define: {
    "import.meta.vitest": "undefined",
  },
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/{cli,equivalence-checker,pruning,contracts}/**/*.test.ts"],
          includeSource: ["src/**/*.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "property",
          include: ["tests/property/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/cli/index.ts"],
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
    },
  },
});
