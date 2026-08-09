import { defineConfig, devices } from "@playwright/test";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://knowledge:knowledge_dev@127.0.0.1:5432/knowledge_e2e_visual";
const apiPort = Number.parseInt(process.env.E2E_API_PORT ?? "3107", 10);
const webPort = Number.parseInt(process.env.E2E_WEB_PORT ?? "5279", 10);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${webPort}`;

process.env.E2E_BASE_URL = baseURL;

export default defineConfig({
  testDir: "./tests/visual",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        viewport: { width: 1_600, height: 1_000 },
      },
    },
  ],
  webServer: [
    {
      command: `env DATABASE_URL=${databaseUrl} SERVER_PORT=${apiPort} node --import tsx tests/visual/e2e-server.ts`,
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
