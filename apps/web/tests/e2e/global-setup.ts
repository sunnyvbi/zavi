import { chromium, type FullConfig, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const AUTH_DIR = path.join(__dirname, ".auth");
export const STORAGE_STATE = path.join(AUTH_DIR, "state.json");

export const QA_EMAIL = process.env.QA_TEST_EMAIL ?? "";

const SUBMIT = 'form button[type="submit"]';
const LOAD_TIMEOUT_MS = 120_000;
const FIELD_TIMEOUT_MS = 60_000;
const SIGN_IN_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;

class CredentialsRejected extends Error {}

function requirePassword(): string {
  const value = process.env.QA_TEST_PASSWORD;
  if (!QA_EMAIL) {
    throw new Error(
      [
        "QA_TEST_EMAIL is not set — the e2e global setup cannot sign in.",
        `  export QA_TEST_EMAIL="$(grep '^QA_TEST_EMAIL=' apps/backend/.env | cut -d= -f2-)"`,
      ].join("\n"),
    );
  }
  if (!value) {
    throw new Error(
      [
        "QA_TEST_PASSWORD is not set — the e2e global setup cannot sign in.",
        "Export it from the backend env before running the suite:",
        `  export QA_TEST_PASSWORD="$(grep '^QA_TEST_PASSWORD=' apps/backend/.env | cut -d= -f2-)"`,
        "Never hardcode, commit or log the value.",
      ].join("\n"),
    );
  }
  return value;
}

async function typeInto(field: Locator, value: string): Promise<void> {
  await field.waitFor({ state: "visible", timeout: FIELD_TIMEOUT_MS });
  await field.click();
  await field.pressSequentially(value, { delay: 15 });
}

async function signIn(page: Page, password: string): Promise<void> {
  await page.goto("/login?next=/workspace", {
    waitUntil: "domcontentloaded",
    timeout: LOAD_TIMEOUT_MS,
  });

  await typeInto(page.getByLabel("Email", { exact: true }), QA_EMAIL);
  await typeInto(page.getByLabel("Password", { exact: true }), password);

  await page
    .locator(`${SUBMIT}:not([disabled])`)
    .first()
    .waitFor({ state: "visible", timeout: FIELD_TIMEOUT_MS });
  await page.locator(SUBMIT).first().click();

  try {
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: SIGN_IN_TIMEOUT_MS,
    });
  } catch (cause) {
    const alert = await page
      .getByRole("alert")
      .first()
      .innerText()
      .catch(() => "");
    const message = `Sign-in did not leave /login for ${QA_EMAIL}. Page alert: ${alert.trim() || "(none)"}`;
    throw alert.trim()
      ? new CredentialsRejected(message, { cause })
      : new Error(message, { cause });
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const password = requirePassword();
  const baseURL =
    process.env.PRAXIS_WEB_BASE_URL ??
    config.projects[0]?.use?.baseURL ??
    "http://localhost:3000";

  mkdirSync(AUTH_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await signIn(page, password);
        break;
      } catch (err) {
        if (err instanceof CredentialsRejected || attempt >= MAX_ATTEMPTS) throw err;
        await context.clearCookies();
      }
    }

    const cookies = await context.cookies();
    const hasSession = cookies.some(
      (c) => c.name.startsWith("sb-") && c.name.includes("auth-token"),
    );
    if (!hasSession) {
      throw new Error(
        `Signed-in navigation reached ${page.url()} but no Supabase auth cookie was written.`,
      );
    }

    await context.storageState({ path: STORAGE_STATE });
  } finally {
    await context.close();
    await browser.close();
  }
}
