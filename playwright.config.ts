import { defineConfig } from "@playwright/test";

const onCi = Boolean(process.env.CI) && !process.env.ACT;

export default defineConfig({
  testDir: "tests/e2e",
  testIgnore: process.env.SCREENSHOTS ? [] : ["**/screenshots.spec.ts"],
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  grepInvert: onCi || process.env.SNAPSHOTS ? undefined : /visual snapshot/,
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFilePath}/{arg}{ext}",
  use: {
    baseURL: "http://127.0.0.1:8787",
    channel: process.env.CI ? undefined : "chrome",
    headless: true,
  },
  expect: {
    toHaveScreenshot: { maxDiffPixels: 200 },
  },
  webServer: {
    command: "npx serve -l 8787 .",
    url: "http://127.0.0.1:8787/",
    reuseExistingServer: !process.env.CI,
  },
});
