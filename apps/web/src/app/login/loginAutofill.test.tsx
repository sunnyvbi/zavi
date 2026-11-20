// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
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

const AUTOFILL_ANIMATION = "zavi-autofill-start";

function signInButton(): HTMLButtonElement {
  const buttons = screen.getAllByRole("button", { name: /^Sign in$/ });
  const submit = buttons.find((b) => (b as HTMLButtonElement).type === "submit");
  if (!submit) throw new Error("no submit-type Sign in button");
  return submit as HTMLButtonElement;
}

function autofill(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
}

function fireAutofillAnimation(input: HTMLInputElement, name = AUTOFILL_ANIMATION) {
  const event = new Event("animationstart", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: name });
  fireEvent(input, event);
}

beforeEach(() => {
  push.mockReset();
});
afterEach(cleanup);

describe("/login — browser autofill", () => {
  it("leaves the button disabled while the form is genuinely empty", async () => {
    render(<LoginPage />);
    await screen.findByLabelText("Email");
    expect(signInButton().disabled).toBe(true);
  });

  it("enables the button for a fill that arrives with no event at all", async () => {
    render(<LoginPage />);
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    const password = screen.getByLabelText("Password") as HTMLInputElement;

    autofill(email, "saved@example.com");
    autofill(password, "savedpassword");

    await waitFor(() => expect(signInButton().disabled).toBe(false));
  });

  it("enables the button for a late fill announced only by the CSS animation", async () => {
    render(<LoginPage />);
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    const password = screen.getByLabelText("Password") as HTMLInputElement;

    await new Promise((r) => setTimeout(r, 400));
    expect(signInButton().disabled).toBe(true);

    autofill(email, "late@example.com");
    autofill(password, "latepassword");
    fireAutofillAnimation(email);
    fireAutofillAnimation(password);

    await waitFor(() => expect(signInButton().disabled).toBe(false));
  });

  it("ignores an unrelated animation on the field", async () => {
    render(<LoginPage />);
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    await new Promise((r) => setTimeout(r, 400));

    autofill(email, "someone@example.com");
    fireAutofillAnimation(email, "some-other-animation");

    expect(signInButton().disabled).toBe(true);
  });

  it("picks up a withheld fill once the user interacts with the page", async () => {
    render(<LoginPage />);
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    await new Promise((r) => setTimeout(r, 400));

    autofill(email, "revealed@example.com");
    autofill(password, "revealedpassword");
    expect(signInButton().disabled).toBe(true);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(signInButton().disabled).toBe(false));
  });

  it("picks up a withheld fill revealed by a gesture that dispatches nothing", async () => {
    render(<LoginPage />);
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    await new Promise((r) => setTimeout(r, 400));

    fireAutofillAnimation(email);
    expect(signInButton().disabled).toBe(true);

    autofill(email, "saved@example.com");
    autofill(password, "savedpassword");
    await waitFor(() => expect(signInButton().disabled).toBe(false), { timeout: 2000 });
  });

  it("does not resurrect a value the user cleared by hand", async () => {
    render(<LoginPage />);
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    const password = screen.getByLabelText("Password") as HTMLInputElement;

    autofill(email, "saved@example.com");
    autofill(password, "savedpassword");
    await waitFor(() => expect(signInButton().disabled).toBe(false));

    fireEvent.change(email, { target: { value: "" } });
    fireEvent.change(password, { target: { value: "" } });

    await new Promise((r) => setTimeout(r, 400));
    expect(email.value).toBe("");
    expect(password.value).toBe("");
    expect(signInButton().disabled).toBe(true);
  });
});
