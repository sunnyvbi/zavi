import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderEmail } from "../theme";

const REPO = resolve(__dirname, "../../../../..");
const MASTHEAD_PATH = "zavi-wordmark-email.png";

const saved = process.env.WEB_BASE_URL;

afterEach(() => {
  if (saved === undefined) delete process.env.WEB_BASE_URL;
  else process.env.WEB_BASE_URL = saved;
});

const shell = () =>
  renderEmail({ title: "Hello", body: "<p>body</p>", kicker: "Mentions", footerVariant: "neutral" });

describe("the masthead every system email carries", () => {
  it("is TEXT in the site's bold sans, not an image hosted on a separately-deployed surface", () => {
    const html = shell();
    expect(html).not.toMatch(/<img[^>]*zavi-wordmark/i);
    expect(html).toContain(">Zavi</a>");
    expect(html).toMatch(/font-family:'Plus Jakarta Sans'[^"]*;font-size:26px;font-weight:800/);
    expect(html).not.toContain("Fraunces");
  });

  it("wraps the wordmark in a link to WEB_BASE_URL, with no trailing path", () => {
    process.env.WEB_BASE_URL = "https://staging.zaviagent.com/";
    expect(shell()).toContain('href="https://staging.zaviagent.com"');
    expect(shell()).not.toContain('href="https://www.zaviagent.com"');
  });

  it("keeps the asset in the repo so re-landing it is a one-line change", () => {
    const served = join(REPO, "apps/web/public", MASTHEAD_PATH);
    expect(existsSync(served), `${served} is the wordmark waiting on a web deploy`).toBe(true);
    expect(statSync(served).size).toBeGreaterThan(0);
  });

  it("is not duplicated as a second wordmark anywhere in the shell", () => {
    expect(shell().match(/>Zavi<\/a>/g)).toHaveLength(1);
  });

  it("reaches every template through the one shell, so no sender hardcodes its own", () => {
    const dir = resolve(__dirname, "..");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "theme.ts")
      .filter((f) => /zavi-wordmark/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
