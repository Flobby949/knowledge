import { defineConfig } from "vitest/config";

process.env.TEST_DATABASE_URL ??=
  "postgresql://knowledge:knowledge_dev@127.0.0.1:5432/knowledge_test";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["tests/e2e/**", "node_modules/**"],
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 20_000,
  },
});
