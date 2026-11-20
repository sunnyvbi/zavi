// @vitest-environment jsdom
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { useLayoutEffect, type ReactNode } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";

vi.mock("next/image", () => ({ default: ({ src, alt, width, height, className }: { src: string; alt: string; width?: number; height?: number; className?: string }) => <img src={src} alt={alt} width={width} height={height} className={className} /> }));

let failRows = false;
let member = false;
let connectorRows: Array<{ slug: string; scopes?: string[]; account_login?: string }> = [];
let teamsStatus = { configured: true, connected: false };
const toolkits = [
  ...Array.from({ length: 60 }, (_, i) => ({ slug: `zapp${i + 1}`, name: `Zapp ${i + 1}`, logo: "", connectable: true })),
  { slug: "zadarma", name: "Zadarma", logo: "", connectable: false },
  { slug: "shopify", name: "Shopify", logo: "", connectable: false },
  { slug: "hubspot", name: "HubSpot", logo: "", connectable: true },
];
let requestedApps: string[] = [];
let catalogMode: "ok" | "hang" | "fail" = "ok";
const apiFetch = vi.fn(async (path: string, _init?: RequestInit) => {
  if (path === "/api/connectors/composio/toolkits" && catalogMode === "hang") return new Promise<Response>(() => {});
  if (path === "/api/connectors/composio/toolkits" && catalogMode === "fail") throw new Error("network");
  if (path === "/api/connectors" && failRows) return { ok: false, status: 503, json: async () => ({}) } as Response;
  const body =
    path === "/api/connectors/composio/toolkits"
      ? { toolkits, requested: requestedApps }
      : path === "/api/connectors" ? { connectors: connectorRows } : path === "/api/connectors/teams/status" ? teamsStatus : {};
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
});
vi.mock("@/lib/api", () => ({ apiFetch: (p: string, init?: RequestInit) => (init ? apiFetch(p, init) : apiFetch(p)) }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => null }));
vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => ({ role: member ? "member" : "owner" }) }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));

const launchConnect = vi.fn(async (_slug: string, _info: unknown) => {});
vi.mock("@/app/connectors/connectStrategies", async (orig) => ({
  ...(await orig<typeof import("@/app/connectors/connectStrategies")>()),
  launchConnect: (slug: string, info: unknown) => launchConnect(slug, info),
}));

const { stubForm } = vi.hoisted(() => ({
  stubForm:
    (name: string) =>
    ({ onClose, inline }: { onClose: () => void; inline?: boolean }) => (
      <div data-testid={`form-${name}`} data-inline={inline ? "yes" : "no"}>
        <button type="button" onClick={onClose}>close {name}</button>
      </div>
    ),
}));
vi.mock("@/app/connectors/PhoneBindForm", () => ({
  PhoneBindForm: (p: { surface: string; onClose: () => void; inline?: boolean }) => stubForm(p.surface)(p),
}));
vi.mock("@/app/connectors/TelegramConnectButton", () => ({ TelegramForm: stubForm("telegram") }));
vi.mock("@/app/connectors/DiscordConnectButton", () => ({ DiscordForm: stubForm("discord") }));
vi.mock("@/app/connectors/StripeConnectButton", () => ({ StripeForm: stubForm("stripe") }));
vi.mock("@/app/connectors/OperatorDbConnectButton", () => ({ OperatorDbForm: stubForm("operator_db") }));
vi.mock("@/app/connectors/PosthogConnectForm", () => ({ PosthogForm: stubForm("posthog") }));
vi.mock("@/app/connectors/SupabaseConnectForm", () => ({ SupabaseForm: stubForm("supabase") }));
vi.mock("../settings/TeamsTile", () => ({ TeamsConnectForm: stubForm("teams") }));

vi.mock("next/navigation", async () => import("./setupNavigation.testSupport"));
import { setSetupLocation } from "./setupNavigation.testSupport";
import { SetupConnectorsStep } from "./SetupConnectorsStep";

beforeEach(() => {
  setSetupLocation();
  connectorRows = [];
  failRows = false;
  member = false;
  teamsStatus = { configured: true, connected: false };
  launchConnect.mockReset();
  launchConnect.mockResolvedValue(undefined);
  apiFetch.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
  requestedApps = [];
  catalogMode = "ok";
});
afterEach(() => { cleanup(); vi.useRealTimers(); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });

const renderStep = (onContinue = vi.fn(), onSkip = vi.fn(), onBack = vi.fn()) => render(<SetupConnectorsStep onContinue={onContinue} onSkip={onSkip} onBack={onBack} />);
const search = (value: string) => fireEvent.change(screen.getByLabelText("Search apps"), { target: { value } });
const ready = async () => waitFor(() => expect((screen.getByRole("button", { name: "Connect Stripe" }) as HTMLButtonElement).disabled).toBe(false));

describe("Connect apps onboarding", () => {
  it("shows 15 apps grouped by type and keeps Skip available with no connections", async () => {
    const onSkip = vi.fn();
    renderStep(vi.fn(), onSkip);
    await ready();
    expect(screen.getByRole("heading", { name: "Connect your apps" })).toBeTruthy();
    expect(screen.getAllByTestId(/^connector-tile-/).map((row) => row.dataset.testid)).toEqual([
      "connector-tile-slack", "connector-tile-whatsapp",
      "connector-tile-google_analytics", "connector-tile-google_search_console",
      "connector-tile-meta_ads", "connector-tile-google_ads", "connector-tile-linkedin_ads",
      "connector-tile-instagram_social", "connector-tile-composio.youtube", "connector-tile-x_social", "connector-tile-linkedin_social",
      "connector-tile-stripe", "connector-tile-composio.hubspot",
      "connector-tile-github", "connector-tile-operator_db",
    ]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(expect.arrayContaining(["Messaging", "Analytics", "Ads", "Social", "Revenue", "Product & data"]));
    expect(screen.queryByRole("button", { name: /Start growing/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onSkip).toHaveBeenCalledOnce();
  });
  it("stores search in the URL while preserving the current workspace and hash", async () => {
    setSetupLocation("/workspace?tab=brain&thread=thread-1#skills");
    renderStep();
    search("google");
    expect(window.location.search).toContain("connectSearch=google");
    expect(window.location.search).toContain("thread=thread-1");
    expect(window.location.hash).toBe("#skills");
    expect(screen.getAllByTestId(/^connector-tile-/)).toHaveLength(2);
    search("no-such-app");
    expect(screen.getByText("No app matches “no-such-app”.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
  });
  it("opens the existing form below the list, closes on Escape, and restores focus", async () => {
    renderStep();
    await ready();
    const button = screen.getByRole("button", { name: "Connect Stripe" });
    fireEvent.click(button);
    const panel = screen.getByRole("region", { name: "Connect Stripe" });
    expect(document.activeElement).toBe(panel);
    expect(window.location.search).toContain("connectApp=stripe");
    expect(within(panel).getByTestId("form-stripe")).toBeTruthy();
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByTestId("form-stripe")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(window.location.search).not.toContain("connectApp");
  });
  it("keeps an open chat form mounted while searching, and switches only when a different app is opened", async () => {
    renderStep();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Connect WhatsApp" }));
    const form = screen.getByTestId("form-whatsapp");
    expect(form.dataset.inline).toBe("yes");
    search("stripe");
    expect(screen.getByTestId("form-whatsapp")).toBe(form);
    fireEvent.click(screen.getByRole("button", { name: "Connect Stripe" }));
    expect(screen.queryByTestId("form-whatsapp")).toBeNull();
    expect(screen.getByTestId("form-stripe")).toBeTruthy();
  });
  it.each(["operator_db", "posthog", "supabase", "telegram", "discord", "teams"])("restores the %s form from its URL", async (slug) => {
    setSetupLocation(`/workspace?connectApp=${slug}`);
    renderStep();
    expect(await screen.findByTestId(`form-${slug}`)).toBeTruthy();
  });
  it("re-reads real connection status when a form closes", async () => {
    renderStep();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Connect Stripe" }));
    connectorRows = [{ slug: "stripe" }];
    fireEvent.click(screen.getByRole("button", { name: "close stripe" }));
    expect(await screen.findByRole("button", { name: "Stripe connected" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start growing with 1 app" })).toBeTruthy();
  });
  it("launches OAuth through the existing launcher and never invents a successful connection", async () => {
    renderStep();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
    await waitFor(() => expect(launchConnect).toHaveBeenCalledWith("slack", expect.anything()));
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect Slack" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "Slack connected" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Start growing/ })).toBeNull();
  });
  it("refreshes when OAuth returns focus and counts connections outside the starter list", async () => {
    const onContinue = vi.fn();
    renderStep(onContinue);
    await ready();
    connectorRows = [{ slug: "github" }, { slug: "stripe" }];
    teamsStatus = { configured: true, connected: true };
    fireEvent(window, new Event("focus"));
    const button = await screen.findByRole("button", { name: "Start growing with 3 apps" });
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledWith(expect.arrayContaining(["GitHub", "Stripe", "Microsoft Teams"]));
  });
  it("preserves the last known connections on a failed refresh and offers Retry", async () => {
    connectorRows = [{ slug: "stripe" }];
    renderStep();
    await screen.findByRole("button", { name: "Stripe connected" });
    failRows = true;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stripe connected" })).toBeTruthy();
    failRows = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading apps" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  it("shows initial status errors without claiming an app is connected", async () => {
    failRows = true;
    renderStep();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Start growing/ })).toBeNull();
  });
  it("keeps SendGrid keys with insufficient campaign permissions out of the ready count", async () => {
    connectorRows = [{ slug: "email", scopes: ["mail_send"] }];
    renderStep();
    search("sendgrid");
    expect(await screen.findByText("Needs more permissions for campaigns")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect SendGrid" }).textContent).toBe("Update key");
    expect(screen.queryByRole("button", { name: /Start growing/ })).toBeNull();
  });
  it("pages the real Composio catalog and uses its existing connect strategy", async () => {
    renderStep();
    await ready();
    search("za");
    await screen.findByTestId("connector-tile-composio.zapp1");
    expect(screen.getAllByTestId(/^connector-tile-composio.zapp/)).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByTestId("connector-tile-composio.zapp60")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect Zapp 7" }));
    await waitFor(() => expect(launchConnect).toHaveBeenCalledWith("composio.zapp7", expect.objectContaining({ connect: "composio" })));
    expect(apiFetch.mock.calls.some(([path]) => path.includes("pipedream"))).toBe(false);
  });
  it("uses the existing request endpoint for apps that cannot connect yet", async () => {
    renderStep();
    await ready();
    search("shopify");
    const row = await screen.findByTestId("connector-tile-composio.shopify");
    fireEvent.click(await within(row).findByRole("button", { name: "I need Shopify" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/connectors/composio/shopify/request", expect.objectContaining({ method: "POST" })));
    expect(await within(row).findByRole("button", { name: "Requested" })).toBeTruthy();
    expect(launchConnect).not.toHaveBeenCalled();
  });
  it.each(["hang", "fail"] as const)("does not offer a catalog connection when catalog mode is %s", async (mode) => {
    catalogMode = mode;
    renderStep();
    await ready();
    search("hubspot");
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/connectors/composio/toolkits"));
    expect(screen.queryByRole("button", { name: "Connect HubSpot" })).toBeNull();
    expect(launchConnect).not.toHaveBeenCalled();
  });
  it("says a featured catalog app could not be checked when the catalog fails, never Coming soon", async () => {
    catalogMode = "fail";
    renderStep();
    await ready();
    const row = await screen.findByTestId("connector-tile-composio.hubspot");
    expect(await within(row).findByText("Couldn't check right now. Reload to try again.")).toBeTruthy();
    expect(within(row).queryByText("Coming soon")).toBeNull();
  });
  it("disables connection mutations for members", async () => {
    member = true;
    renderStep();
    await screen.findByText("Ask an owner or admin to connect your business tools.");
    expect((screen.getByRole("button", { name: "Connect Stripe" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("locks navigation and actions while setup completion is saving", async () => {
    connectorRows = [{ slug: "stripe" }];
    render(<SetupConnectorsStep onContinue={vi.fn()} onSkip={vi.fn()} onBack={vi.fn()} busy error="Couldn't finish setup" />);
    expect(await screen.findByRole("button", { name: "Stripe connected" })).toBeTruthy();
    for (const button of screen.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("Couldn't finish setup");
  });
});

function FirstClient({ children, capture }: { children: ReactNode; capture: () => void }) {
  useLayoutEffect(capture, [capture]);
  return children;
}
describe("Connect apps browser state", () => {
  it("hydrates the same first frame as the server with URL search and a saved open form", async () => {
    setSetupLocation("/workspace?connectSearch=stripe&connectApp=stripe#skills");
    const step = <SetupConnectorsStep onContinue={vi.fn()} onSkip={vi.fn()} onBack={vi.fn()} />;
    const container = document.createElement("div");
    container.innerHTML = renderToString(step);
    document.body.append(container);
    const server = container.cloneNode(true);
    let firstMatches = false;
    let firstHTML = "";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let root: ReturnType<typeof hydrateRoot>;
    try {
      await act(async () => { root = hydrateRoot(container, <FirstClient capture={() => { firstMatches = container.isEqualNode(server); firstHTML = container.innerHTML; }}>{step}</FirstClient>); });
      expect(firstHTML).toBe((server as HTMLElement).innerHTML);
      expect(firstMatches).toBe(true);
      expect(errors.mock.calls.flat().join(" ")).not.toMatch(/hydrat|did not match/i);
      await act(async () => root.unmount());
    } finally {
      container.remove();
      errors.mockRestore();
    }
  });
  it("polls an open chat connection and pauses its reads in a hidden tab", async () => {
    renderStep();
    await ready();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Connect WhatsApp" }));
    const reads = () => apiFetch.mock.calls.filter(([path]) => path === "/api/connectors").length;
    const before = reads();
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(reads()).toBeGreaterThan(before);
    const after = reads();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(reads()).toBe(after);
  });
  it("does not count Zavi's managed GitHub as the customer's connection", async () => {
    connectorRows = [{ slug: "github", account_login: "Praxis-build" }];
    renderStep();
    await ready();
    expect(screen.queryByRole("button", { name: /Start growing/ })).toBeNull();
  });
});
