// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/fonts", () => ({
  inter: { variable: "--font-inter", className: "inter" },
}));
vi.mock("@/components/auth/AuthMarketingPanel", () => ({
  AuthMarketingPanel: () => <aside data-testid="auth-marketing-panel" />,
}));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
  }),
}));

import ResetPasswordPage from "./page";

const HERE = join(__dirname, "..", "..");
const read = (...p: string[]) =>
  readFileSync(join(HERE, ...p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

const RETIRED = [
  "bg-cream",
  "violet",
  "coral",
  "font-display",
  "kicker",
  "tracking-tightest",
  "inkMuted",
];

afterEach(cleanup);

describe("the reset-password page", () => {
  it("renders the same shell the rest of the auth flow does", () => {
    render(<ResetPasswordPage />);
    expect(screen.getByTestId("auth-marketing-panel")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Set a new password." })).toBeTruthy();
  });

  it("takes its field and button styling from the shared auth tokens, not its own", () => {
    render(<ResetPasswordPage />);
    const field = document.querySelector("#new-password")!;
    const submit = screen.getByRole("button", { name: /Save new password/ });
    expect(field.className).toContain("min-h-[48px]");
    expect(field.className).toContain("focus:border-[#171717]");
    expect(submit.className).toContain("bg-[#0e0f11]");
    expect(submit.className).not.toContain("violet");
  });
});

describe("the retired design system", () => {
  for (const file of [
    ["app", "reset-password", "page.tsx"],
    ["app", "login", "page.tsx"],
    ["app", "auth", "callback", "page.tsx"],
    ["components", "auth", "AuthShell.tsx"],
    ["components", "auth", "authUi.ts"],
  ]) {
    it(`is gone from ${file.join("/")}`, () => {
      const source = read(...file);
      const found = RETIRED.filter((token) => source.includes(token));
      expect(found).toEqual([]);
    });
  }
});
