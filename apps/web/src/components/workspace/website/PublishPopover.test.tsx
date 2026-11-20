// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
const toastAdd = vi.fn(() => "toast-1");
vi.mock("@/components/ui/toast", () => ({ toast: { add: (...a: unknown[]) => toastAdd(...(a as [])), update: vi.fn(), close: vi.fn() } }));

import { PublishPopover, splitHost } from "./PublishPopover";
import { prefetchPublishPopover, resetPublishReads } from "./publishReads";

type Builtin = {
  label: string;
  hostname: string;
  url: string;
  status: string;
  dns_ready?: boolean;
  setup_blocked?: "dns_not_configured" | null;
} | null;
type Scenario = {
  visibility?: string;
  status?: { pending: number; published: number; last_published_at: string | null } | "fail";
  builtin?: Builtin | Builtin[];
  ensure?: { status: number; body: unknown };
  setLabel?: { status: number; body: unknown };
  publish?: { status: number; body: unknown };
  customDomainAttached?: boolean;
};

function json(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

function jsonStatus(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function wire(s: Scenario) {
  const builtinSeq = Array.isArray(s.builtin) ? [...s.builtin] : null;
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/website/overview?app=workspace") return json({ visibility: s.visibility ?? "public" });
    if (url === "/api/website/builtin-url/ensure" && init?.method === "POST") {
      return s.ensure ? jsonStatus(s.ensure.status, s.ensure.body) : json({ builtin: null });
    }
    if (url === "/api/website/builtin-url" && init?.method === "POST") {
      return s.setLabel ? jsonStatus(s.setLabel.status, s.setLabel.body) : json({ builtin: null });
    }
    if (url === "/api/website/builtin-url") {
      const next = builtinSeq ? (builtinSeq.length > 1 ? builtinSeq.shift() : builtinSeq[0]) : (s.builtin as Builtin | undefined);
      return json({ builtin: next ?? null, base_domain: "zaviagent.com", custom_domain_attached: s.customDomainAttached === true });
    }
    if (url === "/api/website/publish" && init?.method === "POST") {
      return s.publish ? jsonStatus(s.publish.status, s.publish.body) : json({ published: 1 });
    }
    if (url.startsWith("/api/website/publish-status")) {
      if (s.status === "fail") return json({}, false);
      return json(s.status ?? { pending: 0, published: 0, last_published_at: null });
    }
    if (url === "/api/website/settings" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { visibility: string };
      return json({ visibility: body.visibility, badge_hidden: false });
    }
    return json({});
  });
}

function settingsPosts() {
  return apiFetch.mock.calls.filter(
    ([url, init]) => url === "/api/website/settings" && (init as RequestInit | undefined)?.method === "POST",
  );
}

const LIVE: Builtin = {
  label: "drive-ready-soon",
  hostname: "drive-ready-soon.zaviagent.com",
  url: "https://drive-ready-soon.zaviagent.com",
  status: "live",
};
const VERIFYING: Builtin = { ...LIVE!, status: "verifying" };
const RENDER = "https://drive-ready-soon-abc1.onrender.com";

function posts(url: string) {
  return apiFetch.mock.calls.filter(([u, init]) => u === url && (init as RequestInit | undefined)?.method === "POST");
}

function mount(props: Partial<Parameters<typeof PublishPopover>[0]> = {}) {
  return render(
    <PublishPopover
      appUrl="https://drive-ready-soon.zaviagent.com"
      appHost="drive-ready-soon.zaviagent.com"
      publishable
      onGetDomain={() => {}}
      onClose={() => {}}
      {...props}
    />,
  );
}

async function ready() {
  await waitFor(() => expect(screen.queryByLabelText("Loading publish options")).toBeNull());
}

beforeEach(() => {
  apiFetch.mockReset();
  toastAdd.mockClear();
  resetPublishReads();
});
afterEach(cleanup);

describe("PublishPopover visibility never promises access control it does not enforce", () => {
  it("shows the app as public with no Private or Unlisted choice to make, and saves nothing", async () => {
    wire({});
    mount();
    await ready();
    const row = screen.getByText("Visible to anyone with the link");
    expect(row.closest("button")).toBeNull();
    fireEvent.click(row);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.queryByText(/Private/)).toBeNull();
    expect(screen.queryByText(/Unlisted/)).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Set to Public" })).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(settingsPosts()).toHaveLength(0);
  });

  it("a tenant saved as private earlier is told up front the app is still public and can reset it", async () => {
    wire({ visibility: "private" });
    mount();
    await ready();
    expect(screen.getByText(/anyone with the link can\s+still open it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set to Public" }));
    await waitFor(() => expect(settingsPosts()).toHaveLength(1));
    expect(JSON.parse(String((settingsPosts()[0][1] as RequestInit).body))).toEqual({ visibility: "public" });
    await waitFor(() => expect(screen.queryByText(/still open it/)).toBeNull());
  });
});

describe("PublishPopover opens on what was prefetched", () => {
  it("after a prefetch the first paint is the real status, with no loading skeleton, and a stale prefetch is refreshed in place", async () => {
    wire({ status: { pending: 0, published: 3, last_published_at: null }, builtin: LIVE });
    await prefetchPublishPopover({ editsApp: "drive-ready-soon.zaviagent.com", editsReadable: true, siteSession: false, readsBuiltin: true });
    wire({ status: { pending: 2, published: 3, last_published_at: null }, builtin: LIVE });
    mount();
    expect(screen.queryByLabelText("Loading publish options")).toBeNull();
    expect(screen.getByRole("button", { name: "Up to date" })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("2 unpublished changes").length).toBeGreaterThan(0));
  });

  it("without a prefetch the popover still loads first, and a prefetch for another app is never reused", async () => {
    wire({ status: { pending: 0, published: 3, last_published_at: null }, builtin: LIVE });
    await prefetchPublishPopover({ editsApp: "other.zaviagent.com", editsReadable: true, siteSession: false, readsBuiltin: true });
    mount();
    expect(screen.getByLabelText("Loading publish options")).toBeTruthy();
    await ready();
    expect(screen.getByRole("button", { name: "Up to date" })).toBeTruthy();
  });
});

describe("PublishPopover status header", () => {
  it("up to date: green Live, the button reads Up to date and is disabled", async () => {
    wire({ status: { pending: 0, published: 3, last_published_at: null }, builtin: LIVE });
    mount();
    await ready();
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("Your website is up to date")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Up to date" })).toHaveProperty("disabled", true);
  });

  it("pending edits: counts them and publishing asks for confirmation first", async () => {
    wire({ status: { pending: 2, published: 0, last_published_at: null }, builtin: LIVE });
    mount();
    await ready();
    expect(screen.getAllByText("2 unpublished changes").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Publish changes" }));
    expect(screen.getByText(/live public site/)).toBeTruthy();
    expect(apiFetch.mock.calls.some(([url]) => url === "/api/website/publish")).toBe(false);
  });

  it("does not claim up to date when the publish status could not be read", async () => {
    wire({ status: "fail", builtin: LIVE });
    mount();
    await ready();
    expect(screen.queryByText("Your website is up to date")).toBeNull();
    expect(screen.getByText("Live on the web")).toBeTruthy();
  });

  it("not deployed: Not published, no copy/edit controls, Publish disabled", async () => {
    wire({});
    mount({ appUrl: null, appHost: null });
    await ready();
    expect(screen.getByText("Not published")).toBeTruthy();
    expect(screen.getByText("No live link yet")).toBeTruthy();
    expect(screen.queryByLabelText("Copy link")).toBeNull();
    expect(screen.queryByLabelText("More options")).toBeNull();
    expect(screen.getByRole("button", { name: "Publish" })).toHaveProperty("disabled", true);
  });

  it("no app url while the built-in address is verifying: says it is setting up that address, not 'Build your app'", async () => {
    wire({ builtin: VERIFYING });
    mount({ appUrl: null, appHost: null });
    await ready();
    expect(screen.getByText("Setting up your address")).toBeTruthy();
    expect(screen.getAllByText("drive-ready-soon.zaviagent.com").length).toBeGreaterThan(0);
    expect(screen.queryByText("Not published")).toBeNull();
    expect(screen.queryByText("Build your app to get a live link")).toBeNull();
  });

  it("no app url and no built-in address still says Build your app", async () => {
    wire({ builtin: null });
    mount({ appUrl: null, appHost: null });
    await ready();
    expect(screen.getByText("Not published")).toBeTruthy();
    expect(screen.getByText("Build your app to get a live link")).toBeTruthy();
  });

  it("Add domain routes to Domains and carries no plan badge", async () => {
    wire({ builtin: LIVE });
    const onGetDomain = vi.fn();
    mount({ onGetDomain });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Add domain/ }));
    expect(onGetDomain).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Pro")).toBeNull();
  });
});

describe("splitHost", () => {
  it("bolds the first label and keeps the rest", () => {
    expect(splitHost("https://drive-ready-soon.zaviagent.com/")).toEqual({
      lead: "drive-ready-soon",
      rest: ".zaviagent.com",
    });
    expect(splitHost("https://app.onrender.com/x")).toEqual({ lead: "app", rest: ".onrender.com/x" });
    expect(splitHost(null)).toBeNull();
  });
});

describe("PublishPopover — Lovable-style publish to the Zavi address", () => {
  const renderMount = (props: Partial<Parameters<typeof PublishPopover>[0]> = {}) =>
    mount({ appUrl: RENDER, appHost: "drive-ready-soon-abc1.onrender.com", ...props });

  it("an unpublished built app: Not published, no Render host anywhere, Publish enabled", async () => {
    wire({ builtin: null });
    renderMount();
    await ready();
    expect(screen.getByText("Not published")).toBeTruthy();
    expect(screen.getByText("Publish to put it live at a zaviagent.com address")).toBeTruthy();
    expect(screen.getByText("No public link yet")).toBeTruthy();
    expect(document.body.textContent).not.toContain("onrender");
    expect(document.body.innerHTML).not.toContain("onrender");
    expect(screen.queryByLabelText("Copy link")).toBeNull();
    expect(screen.queryByLabelText("More options")).toBeNull();
    expect(screen.getByRole("button", { name: "Publish" })).toHaveProperty("disabled", false);
  });

  it("first publish: confirm, then it asks the server for the address, and no edit publish is posted when nothing is pending", async () => {
    const onPublished = vi.fn();
    wire({ builtin: [null, VERIFYING, LIVE], ensure: { status: 200, body: { builtin: VERIFYING, base_domain: "zaviagent.com" } } });
    renderMount({ onPublished });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(screen.getByText(/anyone\s+can open/)).toBeTruthy();
    expect(posts("/api/website/builtin-url/ensure")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(posts("/api/website/builtin-url/ensure")).toHaveLength(1));
    expect(posts("/api/website/publish")).toHaveLength(0);
    await waitFor(() => expect(screen.getByText("Publishing…")).toBeTruthy());
    expect(screen.getByText("Setting up drive-ready-soon.zaviagent.com")).toBeTruthy();
    expect(onPublished).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("onrender");
  });

  it("polls the address until it goes live, then flips to Published once and tells the parent", async () => {
    vi.useFakeTimers();
    try {
      const onPublished = vi.fn();
      wire({ builtin: [VERIFYING, VERIFYING, LIVE], status: { pending: 0, published: 0, last_published_at: null } });
      renderMount({ onPublished });
      await vi.waitFor(() => expect(screen.queryByLabelText("Loading publish options")).toBeNull());
      expect(screen.getByText("Publishing…")).toBeTruthy();
      expect(screen.getByText("Setting up…")).toBeTruthy();
      const gets = () => apiFetch.mock.calls.filter(([u, init]) => u === "/api/website/builtin-url" && !(init as RequestInit | undefined)?.method).length;
      const before = gets();
      await vi.advanceTimersByTimeAsync(4000);
      expect(gets()).toBe(before + 1);
      await vi.advanceTimersByTimeAsync(4000);
      await vi.waitFor(() => expect(screen.getByText("Live")).toBeTruthy());
      expect(onPublished).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(12000);
      expect(onPublished).toHaveBeenCalledTimes(1);
      expect(screen.getByText("drive-ready-soon")).toBeTruthy();
      expect(document.body.textContent).not.toContain("onrender");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says DNS is still being set up when the server has not written it, and gives up honestly after the poll cap with a Check again", async () => {
    vi.useFakeTimers();
    try {
      wire({ builtin: { ...VERIFYING!, dns_ready: false }, status: { pending: 0, published: 0, last_published_at: null } });
      renderMount();
      await vi.waitFor(() => expect(screen.queryByLabelText("Loading publish options")).toBeNull());
      expect(screen.getByText("Setting up DNS for drive-ready-soon.zaviagent.com")).toBeTruthy();
      const gets = () => apiFetch.mock.calls.filter(([u, init]) => u === "/api/website/builtin-url" && !(init as RequestInit | undefined)?.method).length;
      await vi.advanceTimersByTimeAsync(4000 * 45);
      const atCap = gets();
      await vi.waitFor(() => expect(screen.getByText("Still setting up")).toBeTruthy());
      expect(screen.queryByText("Live")).toBeNull();
      await vi.advanceTimersByTimeAsync(4000 * 3);
      expect(gets()).toBe(atCap);
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await vi.waitFor(() => expect(gets()).toBe(atCap + 1));
      await vi.advanceTimersByTimeAsync(4000);
      expect(gets()).toBe(atCap + 2);
      expect(document.body.textContent).not.toContain("onrender");
    } finally {
      vi.useRealTimers();
    }
  });

  it("first publish that lands with DNS still pending says so and starts polling", async () => {
    vi.useFakeTimers();
    try {
      const pendingDns = { ...VERIFYING!, dns_ready: false };
      wire({ builtin: [null, pendingDns, pendingDns, LIVE], ensure: { status: 200, body: { builtin: pendingDns, base_domain: "zaviagent.com" } } });
      renderMount();
      await vi.waitFor(() => expect(screen.queryByLabelText("Loading publish options")).toBeNull());
      fireEvent.click(screen.getByRole("button", { name: "Publish" }));
      fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
      await vi.waitFor(() => expect(screen.getByText("Setting up DNS for drive-ready-soon.zaviagent.com")).toBeTruthy());
      const gets = () => apiFetch.mock.calls.filter(([u, init]) => u === "/api/website/builtin-url" && !(init as RequestInit | undefined)?.method).length;
      const before = gets();
      await vi.advanceTimersByTimeAsync(4000);
      expect(gets()).toBe(before + 1);
      await vi.advanceTimersByTimeAsync(8000);
      await vi.waitFor(() => expect(screen.getByText("Live")).toBeTruthy());
      expect(screen.getByRole("button", { name: "Up to date" })).toHaveProperty("disabled", true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("when the server cannot write DNS at all it says so plainly, stops polling, and still publishes pending edits", async () => {
    vi.useFakeTimers();
    try {
      const blocked = { ...VERIFYING!, dns_ready: false, setup_blocked: "dns_not_configured" as const };
      wire({ builtin: blocked, status: { pending: 1, published: 0, last_published_at: null } });
      renderMount();
      await vi.waitFor(() => expect(screen.queryByLabelText("Loading publish options")).toBeNull());
      expect(screen.getByText(/can't write DNS/)).toBeTruthy();
      expect(screen.getByText("Not live yet")).toBeTruthy();
      expect(screen.queryByText("Publishing…")).toBeNull();
      expect(screen.queryByText("Setting up…")).toBeNull();
      expect(screen.queryByText(/Setting up DNS/)).toBeNull();
      expect(document.querySelector(".animate-spin")).toBeNull();
      const gets = () => apiFetch.mock.calls.filter(([u, init]) => u === "/api/website/builtin-url" && !(init as RequestInit | undefined)?.method).length;
      const before = gets();
      await vi.advanceTimersByTimeAsync(4000 * 5);
      expect(gets()).toBe(before);
      expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
      expect(screen.getByText("drive-ready-soon")).toBeTruthy();
      const publish = screen.getByRole("button", { name: "Publish" });
      expect(publish).toHaveProperty("disabled", false);
      fireEvent.click(publish);
      fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
      await vi.waitFor(() => expect(posts("/api/website/publish")).toHaveLength(1));
      expect(posts("/api/website/builtin-url/ensure")).toHaveLength(1);
      expect(document.body.textContent).not.toMatch(/cloudflare|render/i);
      expect(document.body.textContent).not.toContain("onrender");
    } finally {
      vi.useRealTimers();
    }
  });

  it("live address + pending edits: Publish changes posts the edits and never re-asks for an address", async () => {
    wire({ builtin: LIVE, status: { pending: 2, published: 1, last_published_at: null } });
    renderMount();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Publish changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(posts("/api/website/publish")).toHaveLength(1));
    expect(JSON.parse(String(posts("/api/website/publish")[0][1]!.body))).toEqual({ app_id: "drive-ready-soon-abc1.onrender.com" });
    expect(posts("/api/website/builtin-url/ensure")).toHaveLength(0);
  });

  it("copy and Open app use the Zavi address, never the Render URL, when the app is live there", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    wire({ builtin: LIVE, status: { pending: 0, published: 0, last_published_at: null } });
    renderMount();
    await ready();
    fireEvent.click(screen.getByLabelText("Copy link"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://drive-ready-soon.zaviagent.com"));
    fireEvent.click(screen.getByLabelText("More options"));
    expect(screen.getByRole("menuitem", { name: /Open app/ }).getAttribute("href")).toBe("https://drive-ready-soon.zaviagent.com");
    expect(document.body.innerHTML).not.toContain("onrender");
  });

  it("a viewer, who cannot publish, is told so, and nothing else is posted", async () => {
    wire({ builtin: null, ensure: { status: 403, body: { error: { code: "forbidden" } } } });
    renderMount();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Viewers can't publish"));
    expect(posts("/api/website/publish")).toHaveLength(0);
    expect(screen.getByText("Not published")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish" })).toHaveProperty("disabled", false);
  });

  it("edit URL: saves a new name through the address endpoint and shows a taken name inline", async () => {
    const onPublished = vi.fn();
    wire({ builtin: LIVE, setLabel: { status: 409, body: { error: { code: "label_taken", message: "That URL is already taken. Try another." } } } });
    renderMount({ onPublished });
    await ready();
    fireEvent.click(screen.getByLabelText("Edit URL"));
    const input = screen.getByLabelText("Website address name") as HTMLInputElement;
    expect(input.value).toBe("drive-ready-soon");
    expect(screen.getByText(".zaviagent.com")).toBeTruthy();
    fireEvent.change(input, { target: { value: "Cool-App" } });
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("already taken"));
    expect(JSON.parse(String(posts("/api/website/builtin-url")[0][1]!.body))).toEqual({ label: "cool-app" });
    expect(onPublished).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Website address name")).toBeTruthy();
  });

  it("edit URL: a successful rename swaps the shown address and notifies the parent", async () => {
    const onPublished = vi.fn();
    const renamed = { label: "cool-app", hostname: "cool-app.zaviagent.com", url: "https://cool-app.zaviagent.com", status: "verifying" };
    wire({ builtin: LIVE, setLabel: { status: 200, body: { builtin: renamed } } });
    renderMount({ onPublished });
    await ready();
    fireEvent.click(screen.getByLabelText("Edit URL"));
    fireEvent.change(screen.getByLabelText("Website address name"), { target: { value: "cool-app" } });
    fireEvent.keyDown(screen.getByLabelText("Website address name"), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("cool-app")).toBeTruthy());
    expect(onPublished).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Setting up…")).toBeTruthy();
  });

  it("edit URL is disabled with a reason while a custom domain points at the address", async () => {
    wire({ builtin: LIVE, customDomainAttached: true });
    renderMount({});
    await ready();
    await waitFor(() => expect(screen.getByLabelText("Edit URL")).toHaveProperty("disabled", true));
    expect(screen.getByText("Remove your custom domain first to change your Zavi address.")).toBeTruthy();
  });

  it("a registered external site is left alone: no address editing, its own URL shown", async () => {
    wire({});
    mount({ appUrl: "https://www.acme.com", appHost: "www.acme.com", publishable: false });
    await ready();
    expect(screen.getByTitle("https://www.acme.com").textContent).toBe("www.acme.com");
    expect(screen.queryByLabelText("Edit URL")).toBeNull();
    expect(apiFetch.mock.calls.some(([u]) => u === "/api/website/builtin-url")).toBe(false);
  });
});

describe("PublishPopover — an address that exists but is not live can still be published", () => {
  it("keeps Publish enabled while the address is still setting up, and a click re-runs the setup", async () => {
    wire({ builtin: VERIFYING, ensure: { status: 200, body: { builtin: VERIFYING, base_domain: "zaviagent.com" } } });
    mount({ appUrl: RENDER, appHost: "drive-ready-soon-abc1.onrender.com" });
    await ready();
    const publish = screen.getByRole("button", { name: "Publish" });
    expect(publish).toHaveProperty("disabled", false);
    fireEvent.click(publish);
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(posts("/api/website/builtin-url/ensure")).toHaveLength(1));
    expect(posts("/api/website/publish")).toHaveLength(0);
  });

  it("when DNS is not configured on the server, Publish is still allowed and the click says exactly why it cannot go live", async () => {
    const blocked = { ...VERIFYING!, dns_ready: false, setup_blocked: "dns_not_configured" as const };
    wire({ builtin: blocked, ensure: { status: 200, body: { builtin: blocked, base_domain: "zaviagent.com" } } });
    mount({ appUrl: RENDER, appHost: "drive-ready-soon-abc1.onrender.com" });
    await ready();
    expect(screen.getByText("Not live yet")).toBeTruthy();
    const publish = screen.getByRole("button", { name: "Publish" });
    expect(publish).toHaveProperty("disabled", false);
    fireEvent.click(publish);
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(posts("/api/website/builtin-url/ensure")).toHaveLength(1));
    await waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "warning", title: "Still can't go live here" })));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByText(/can't write DNS/)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Publish" })).toHaveProperty("disabled", false);
  });
});

describe("PublishPopover — a new-flow site session shows THAT site, never the workspace's old address (B21)", () => {
  const OLD_APP: Builtin = {
    label: "apna-tutor-693dfbdb",
    hostname: "apna-tutor-693dfbdb.zaviagent.com",
    url: "https://apna-tutor-693dfbdb.zaviagent.com",
    status: "live",
  };
  const SITE_URL = "https://mile-high-coffee-693dfbdb-523441.zaviagent.com";

  it("shows the live site's own URL and never reads the workspace built-in address", async () => {
    wire({ builtin: OLD_APP });
    mount({ appUrl: SITE_URL, appHost: new URL(SITE_URL).host, site: { liveUrl: SITE_URL, status: "live" } });
    await ready();
    expect(screen.getByTitle(SITE_URL)).toBeTruthy();
    expect(screen.queryByText(/apna-tutor-693dfbdb/)).toBeNull();
    expect(apiFetch.mock.calls.some(([u]) => u === "/api/website/builtin-url")).toBe(false);
    expect(screen.queryByLabelText("Edit URL")).toBeNull();
    expect(screen.queryByText("Add domain")).toBeNull();
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("a site never reads or publishes inline overlay edits (its host has no edit runtime), nor ensures the workspace address", async () => {
    wire({ builtin: OLD_APP, status: { pending: 2, published: 0, last_published_at: null } });
    mount({ appUrl: SITE_URL, appHost: new URL(SITE_URL).host, site: { liveUrl: SITE_URL, status: "live" } });
    await ready();
    expect(apiFetch.mock.calls.some(([u]) => String(u).startsWith("/api/website/publish-status"))).toBe(false);
    expect(apiFetch.mock.calls.some(([u]) => String(u).startsWith("/api/website/pending"))).toBe(false);
    expect(screen.queryByRole("button", { name: "Publish changes" })).toBeNull();
    expect(posts("/api/website/publish")).toHaveLength(0);
    expect(posts("/api/website/builtin-url/ensure")).toHaveLength(0);
  });

  it("a site that is still building says so instead of borrowing another app's Live state", async () => {
    wire({ builtin: OLD_APP });
    mount({ appUrl: SITE_URL, appHost: new URL(SITE_URL).host, site: { liveUrl: null, status: "publishing" } });
    await ready();
    expect(screen.getByText("Not live yet")).toBeTruthy();
    expect(screen.queryByText(/apna-tutor-693dfbdb/)).toBeNull();
  });

  it("a live site republishing keeps showing its live address", async () => {
    wire({ builtin: OLD_APP });
    mount({ appUrl: SITE_URL, appHost: new URL(SITE_URL).host, site: { liveUrl: SITE_URL, status: "publishing" } });
    await ready();
    expect(screen.getByTitle(SITE_URL)).toBeTruthy();
    expect(screen.queryByText("Not live yet")).toBeNull();
  });

  it("never reads or resets the workspace app's stored visibility in a site session", async () => {
    wire({ builtin: OLD_APP, visibility: "private" });
    mount({ appUrl: SITE_URL, appHost: new URL(SITE_URL).host, site: { liveUrl: SITE_URL, status: "live" } });
    await ready();
    expect(apiFetch.mock.calls.some(([u]) => String(u).startsWith("/api/website/overview"))).toBe(false);
    expect(screen.queryByText(/was set to private/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Set to Public" })).toBeNull();
    expect(settingsPosts()).toHaveLength(0);
  });
});
