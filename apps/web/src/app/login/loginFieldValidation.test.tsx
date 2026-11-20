// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/fonts", () => ({
  inter: { variable: "--font-inter", className: "inter" },
}));
vi.mock("next/link", () => ({
  default: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    auth: {
      signInWithPassword: vi.fn(async () => ({ data: {}, error: null })),
      signInWithOAuth: vi.fn(async () => ({ data: {}, error: null })),
    },
  }),
}));
vi.mock("@/lib/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiUrl: (p: string) => `http://api.test${p}` }));
vi.mock("@/components/auth/AuthMarketingPanel", () => ({ AuthMarketingPanel: () => null }));
vi.mock("@/components/auth/SlackWorkspaceHint", () => ({ SlackWorkspaceHint: () => null }));
vi.mock("@/components/marketing/ZaviWordmark", () => ({ ZaviWordmark: () => null }));

import LoginPage from "./page";

const REQUIRED = "Email is required.";
const MALFORMED = /Enter a valid email address/;

function emailField(): HTMLInputElement {
  return screen.getByLabelText("Email") as HTMLInputElement;
}

function passwordField(): HTMLInputElement {
  return screen.getByLabelText("Password") as HTMLInputElement;
}

function fieldError(): string | null {
  return document.getElementById("email-error")?.textContent ?? null;
}

function passwordFieldError(): string | null {
  return document.getElementById("password-error")?.textContent ?? null;
}

function goForgot() {
  fireEvent.click(screen.getByRole("button", { name: /Forgot password\?/ }));
}

function typeInto(el: HTMLInputElement, text: string, onEachRender: () => void) {
  let sofar = "";
  for (const ch of text) {
    sofar += ch;
    fireEvent.change(el, { target: { value: sofar } });
    onEachRender();
  }
}

afterEach(cleanup);

describe("login inline field validation", () => {
  it("1. says nothing on a freshly mounted reset form", () => {
    render(<LoginPage />);
    goForgot();
    expect(fieldError()).toBeNull();
    expect(emailField().getAttribute("aria-invalid")).toBeNull();
  });

  it("2. stays silent through all 12 characters of a half-typed address", () => {
    render(<LoginPage />);
    goForgot();
    const el = emailField();

    fireEvent.blur(el);
    expect(fieldError()).toBe(REQUIRED);

    fireEvent.focus(el);
    typeInto(el, "mohit@upcar", () => {
      expect(fieldError()).toBeNull();
      expect(el.getAttribute("aria-invalid")).toBeNull();
    });
    typeInto(el, "mohit@upcar.", () => {
      expect(fieldError()).toBeNull();
    });
    expect(el.value).toBe("mohit@upcar.");
  });

  it("3. does not call an emptied field 'required' while the cursor is still in it", () => {
    render(<LoginPage />);
    goForgot();
    const el = emailField();

    fireEvent.change(el, { target: { value: "mohit@upcar" } });
    fireEvent.blur(el);
    expect(fieldError()).toMatch(MALFORMED);

    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: "" } });
    expect(fieldError()).toBeNull();
    expect(el.getAttribute("aria-invalid")).toBeNull();
  });

  it("4. still flags a malformed address once the user leaves the field", () => {
    render(<LoginPage />);
    goForgot();
    const el = emailField();

    fireEvent.change(el, { target: { value: "mohit@upcar" } });
    expect(fieldError()).toBeNull();

    fireEvent.blur(el);
    expect(fieldError()).toMatch(MALFORMED);
    expect(el.getAttribute("aria-invalid")).toBe("true");
  });

  it("5. clears the error when a blurred value is corrected and blurred again", () => {
    render(<LoginPage />);
    goForgot();
    const el = emailField();

    fireEvent.change(el, { target: { value: "mohit@upcar" } });
    fireEvent.blur(el);
    expect(fieldError()).toMatch(MALFORMED);

    fireEvent.change(el, { target: { value: "mohit@upcar.ai" } });
    fireEvent.blur(el);
    expect(fieldError()).toBeNull();
  });

  it("6. holds the same line on the password field", () => {
    render(<LoginPage />);
    const el = passwordField();

    fireEvent.blur(el);
    expect(passwordFieldError()).toBe("Password is required.");

    fireEvent.focus(el);
    typeInto(el, "hunter2", () => {
      expect(passwordFieldError()).toBeNull();
    });
    fireEvent.change(el, { target: { value: "" } });
    expect(passwordFieldError()).toBeNull();
  });

  it("7. drops a stale error when the form changes shape", () => {
    render(<LoginPage />);
    const el = emailField();

    fireEvent.change(el, { target: { value: "mohit@upcar" } });
    fireEvent.blur(el);
    expect(fieldError()).toMatch(MALFORMED);

    goForgot();
    expect(fieldError()).toBeNull();
  });

  it("8. keeps the submit gate closed even while it says nothing", () => {
    render(<LoginPage />);
    goForgot();
    const el = emailField();

    fireEvent.change(el, { target: { value: "mohit@upcar" } });
    expect(fieldError()).toBeNull();

    const submit = screen
      .getAllByRole("button", { name: /Email reset link/ })
      .find((b) => (b as HTMLButtonElement).type === "submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});
