const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const repo = path.resolve(__dirname, "../../../..");
const admin = path.join(repo, "apps/admin");
const r = createRequire(path.join(repo, "package.json"));
const { chromium } = createRequire(path.join(repo, "apps/web/package.json"))(
  "@playwright/test",
);
const dir = path.join(repo, "output/admin-growth/browser");
async function build() {
  fs.mkdirSync(dir, { recursive: true });
  await r("esbuild").build({
    entryPoints: [path.join(__dirname, "entry.tsx")],
    bundle: true,
    outfile: path.join(dir, "app.js"),
    platform: "browser",
    jsx: "automatic",
    alias: {
      "next/navigation": path.join(__dirname, "navigation.tsx"),
      "next/link": path.join(__dirname, "navigation.tsx"),
      "@/components/admin/AdminGate": path.join(__dirname, "navigation.tsx"),
      "@/lib/supabase-admin": path.join(__dirname, "navigation.tsx"),
      "@/lib/api-admin": path.join(__dirname, "api.ts"),
      "@": path.join(admin, "src"),
    },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  execFileSync(
    process.execPath,
    [
      r.resolve("tailwindcss/lib/cli.js"),
      "-i",
      "src/app/globals.css",
      "-o",
      path.join(dir, "style.css"),
    ],
    { cwd: admin, stdio: "pipe" },
  );
  fs.copyFileSync(
    path.join(__dirname, "index.html"),
    path.join(dir, "index.html"),
  );
}
(async () => {
  await build();
  const server = http.createServer((req, res) => {
    const path = req.url === "/" ? "index.html" : req.url.slice(1);
    if (!["index.html", "style.css", "app.js"].includes(path)) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader(
      "Content-Type",
      path.endsWith(".css")
        ? "text/css"
        : path.endsWith(".js")
          ? "text/javascript"
          : "text/html",
    );
    res.end(fs.readFileSync(dir + "/" + path));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1"
        ? route.continue()
        : route.abort(),
    );
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.getByRole("heading", { name: "Tenants", exact: true }).waitFor();
    await page.getByRole("button", { name: /On a paid plan/ }).waitFor();
    assert.equal(
      await page
        .getByRole("region", { name: "Workspace table" })
        .locator("tbody tr")
        .count(),
      2,
    );
    await page.getByRole("button", { name: /On a paid plan/ }).click();
    await page.getByText("No accounts match these filters.").waitFor();
    await page.getByRole("button", { name: /On a paid plan/ }).click();
    await page.getByLabel("Show test workspaces").check();
    assert.equal(
      await page
        .getByRole("region", { name: "Workspace table" })
        .locator("tbody tr")
        .count(),
      3,
    );
    await page.getByRole("button", { name: /On a paid plan/ }).click();
    assert.equal(
      await page
        .getByRole("region", { name: "Workspace table" })
        .locator("tbody tr")
        .count(),
      1,
    );
    await page.getByRole("button", { name: /On a paid plan/ }).click();
    await page.getByLabel("Show test workspaces").uncheck();
    await page.getByLabel("To date").fill("2026-10-13");
    await page.getByLabel("From date").fill("2026-10-01");
    await page
      .getByRole("img", { name: "Daily signups, 13 days", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("img", { name: "Daily signups, 13 days", exact: true })
        .locator("g[tabindex]")
        .count(),
      13,
    );
    await page.getByRole("button", { name: "Line", exact: true }).click();
    assert.equal(
      await page
        .getByRole("img", { name: "Daily signups, 13 days", exact: true })
        .locator("polyline")
        .count(),
      1,
    );
    await page
      .getByRole("button", { name: "Active users", exact: true })
      .click();
    await page.getByText(/Earlier days include saved messages/).waitFor();
    await page.getByLabel("Usage columns").check();
    await page
      .getByRole("columnheader", { name: "Cost", exact: true })
      .waitFor();
    await page.getByText("$1.25").first().waitFor();
    await page.getByLabel("Usage columns").uncheck();
    await page.getByRole("region", { name: "Workspace table" }).waitFor();
    await page.screenshot({ path: dir + "/desktop.png", fullPage: true });
    await page.getByLabel("Select all visible accounts").check();
    await page
      .getByRole("button", { name: "Mark as test", exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    await page
      .getByLabel("Review reason")
      .fill("Synthetic fixture review only");
    await page.getByRole("button", { name: "Confirm classification" }).click();
    await page.getByText("2 account classifications saved.").waitFor();
    await page.getByText("No accounts match these filters.").waitFor();
    await page.getByLabel("Show test workspaces").check();
    await page
      .getByRole("region", { name: "Workspace table" })
      .locator("tbody tr")
      .first()
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () =>
        Math.round(
          document.querySelector("aside").getBoundingClientRect().width,
        ) === 56,
    );
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await page
      .getByRole("button", { name: "Close navigation", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        Math.round(
          document.querySelector("aside").getBoundingClientRect().width,
        ) === 56,
    );
    await page.screenshot({ path: dir + "/mobile.png", fullPage: true });
    const dims = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: innerWidth,
      table: document.querySelector('[aria-label="Workspace table"]')
        .scrollWidth,
      box: document.querySelector('[aria-label="Workspace table"]').clientWidth,
    }));
    assert(dims.page <= dims.viewport, JSON.stringify(dims));
    assert(dims.table > dims.box, JSON.stringify(dims));
    await page.getByText("People marked test", { exact: true }).click();
    await page
      .getByLabel("Select person test@yopmail.com", { exact: true })
      .check();
    await page
      .getByRole("button", { name: "Mark as real", exact: true })
      .click();
    await page
      .getByLabel("Review reason")
      .fill("Restore synthetic person after review");
    await page.getByRole("button", { name: "Confirm classification" }).click();
    await page.getByText("1 account classifications saved.").waitFor();
    await page.getByRole("region", { name: "Workspace table" }).waitFor();
    assert.equal(
      await page.getByText("People marked test", { exact: true }).count(),
      0,
    );
    await page.evaluate(() =>
      window.dispatchEvent(new Event("growth-fixture-fail-next")),
    );
    await page.getByRole("button", { name: "90d", exact: true }).click();
    await page
      .getByText("Synthetic read unavailable", { exact: false })
      .waitFor();
    assert.equal(
      await page.getByRole("region", { name: "Workspace table" }).count(),
      0,
    );
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("region", { name: "Workspace table" }).waitFor();
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: [
          "cards toggle",
          "test filter",
          "13 inclusive days",
          "chart switches",
          "usage toggle",
          "bulk confirmation",
          "mobile menu opens and closes",
          "mobile internal scroll",
          "restore person classification",
          "failed read shows no stale data and retry recovers",
          "no runtime errors",
        ],
        dimensions: dims,
      }),
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
