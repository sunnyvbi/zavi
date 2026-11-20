// @vitest-environment jsdom

import type { ReactNode, JSX } from "react";
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
const nothing = () => null;

vi.mock("./globals.css", () => ({}));
vi.mock("./workspace-dark.css", () => ({}));
vi.mock("@/fonts", () => ({
  jakartaBody: { variable: "__variable_body" },
  interUi: { variable: "__variable_ui" },
  reading: { variable: "__variable_reading" },
  code: { variable: "__variable_code" },
}));
vi.mock("@/components/SignupLocationCapture", () => ({ SignupLocationCapture: nothing }));
vi.mock("@/components/ChunkLoadRecovery", () => ({ ChunkLoadRecovery: nothing }));
vi.mock("@/components/MagicLinkFragmentCatcher", () => ({ MagicLinkFragmentCatcher: nothing }));
vi.mock("@/components/FirstTouchCapture", () => ({ FirstTouchCapture: nothing }));
vi.mock("./PostHogProvider", () => ({ PostHogProvider: passthrough }));
vi.mock("@/lib/analytics/mixpanel", () => ({ MixpanelProvider: passthrough }));
vi.mock("@/lib/analytics/google", () => ({ GoogleAnalyticsProvider: passthrough }));
vi.mock("@/lib/analytics/clicks", () => ({ ClickTracking: nothing }));
vi.mock("@/lib/analytics/auth", () => ({ AuthEventTracking: nothing }));
vi.mock("@/components/marketing/StructuredData", () => ({ SiteStructuredData: nothing }));
vi.mock("@/components/marketing/CookieBanner", () => ({ CookieBanner: nothing }));
vi.mock("@/components/ui/toast", () => ({ Toaster: nothing }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ ConfirmDialogHost: nothing }));
vi.mock("@/components/MirrorBanner", () => ({ MirrorBanner: nothing }));
vi.mock("@/components/TenantDisabledNotice", () => ({ TenantDisabledNotice: nothing }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

let RootLayout: (props: { children: ReactNode }) => Promise<JSX.Element>;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  RootLayout = (await import("./layout")).default;
});

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

async function serveAndBoot(path: string) {
  const tree = await RootLayout({ children: <main>workspace</main> });
  const served = new DOMParser().parseFromString(renderToString(tree), "text/html");
  window.history.replaceState(null, "", path);
  if (!document.documentElement) document.appendChild(document.createElement("html"));
  for (const name of Array.from(document.documentElement.getAttributeNames())) {
    document.documentElement.removeAttribute(name);
  }
  for (const attr of Array.from(served.documentElement.attributes)) {
    document.documentElement.setAttribute(attr.name, attr.value);
  }
  document.documentElement.innerHTML = served.documentElement.innerHTML;
  const boot = document.getElementById("zavi-theme-boot");
  if (!boot?.textContent) throw new Error("the served page has no theme boot script");
  new Function(boot.textContent)();
  return tree;
}

function hydrationErrors(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map((args) => args.map(String).join(" "))
    .filter((line) => /did not match|hydrat/i.test(line));
}

describe("RootLayout hydration under the pre-hydration theme boot", () => {
  it("hydrates a dark workspace without a className mismatch and keeps it dark", async () => {
    window.localStorage.setItem("zavi:dark", "1");
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
    const tree = await serveAndBoot("/workspace");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => {
      root = hydrateRoot(document, tree);
    });

    expect(hydrationErrors(errors)).toEqual([]);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("__variable_body")).toBe(true);
  });

  it("boots the connect tab's done page dark too, so it never flashes white over a dark workspace", async () => {
    window.localStorage.setItem("zavi:dark", "1");
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
    await serveAndBoot("/connectors/composio/done");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("guard: hydrates a light marketing page with no dark class and no warning", async () => {
    window.localStorage.setItem("zavi:dark", "1");
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
    const tree = await serveAndBoot("/pricing");

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => {
      root = hydrateRoot(document, tree);
    });

    expect(hydrationErrors(errors)).toEqual([]);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
