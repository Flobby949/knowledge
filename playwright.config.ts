import { defineConfig, devices } from "@playwright/test";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://knowledge:knowledge_dev@127.0.0.1:5432/knowledge_test";
const apiPort = Number.parseInt(process.env.E2E_API_PORT ?? "3001", 10);
const webPort = Number.parseInt(process.env.E2E_WEB_PORT ?? "5173", 10);
const baseURL =
  process.env.E2E_BASE_URL ?? `http://127.0.0.1:${webPort}`;

process.env.E2E_BASE_URL = baseURL;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        viewport: { width: 1600, height: 1000 },
      },
    },
  ],
  webServer: [
    {
      command: `env DATABASE_URL=${databaseUrl} SERVER_PORT=${apiPort} node --import tsx tests/support/e2e-server.ts`,
      port: apiPort,
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: `env VITE_API_PORT=${apiPort} node_modules/.bin/vite --host 127.0.0.1 --port ${webPort} --strictPort`,
      port: webPort,
      reuseExistingServer: false,
      timeout: 20_000,
    },
  ],
});
