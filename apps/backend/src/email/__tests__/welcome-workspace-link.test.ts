import { describe, it, expect, afterEach, vi } from "vitest";
import { renderWelcomeEmail } from "../templates/welcome";
import { workspaceUrl } from "@/services/web-base";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the welcome email's links", () => {
  it("come from WEB_BASE_URL, not the first WEB_ORIGIN entry", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_ORIGIN", "http://localhost:3000,https://www.zaviagent.com");
    vi.stubEnv("WEB_BASE_URL", "https://www.zaviagent.com");
    const { html, text } = renderWelcomeEmail({ displayName: "UpcarAI", workspaceUrl: workspaceUrl() });
    for (const part of [html, text]) expect(part).not.toContain("localhost");
    expect(html).toContain('href="https://www.zaviagent.com"');
    expect(html).toContain("https://www.zaviagent.com/workspace?tab=settings#connector-slack");
  });
});
