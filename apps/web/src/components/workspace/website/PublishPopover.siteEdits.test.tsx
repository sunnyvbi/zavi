// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/components/ui/toast", () => ({ toast: { add: vi.fn() } }));

import { PublishPopover, SITE_EDITS_APPLY_HINT, SITE_EDITS_APPLYING_HINT, type SitePublishOnRequest } from "./PublishPopover";

const SITE_KEY = "site:aaaaaaaa-0000-4000-8000-000000000001";
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const sitePublish: SitePublishOnRequest = { siteId: "aaaaaaaa-0000-4000-8000-000000000001", hostname: "a.zaviagent.com", built: true, status: "live" };

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

type Server = {
  pending: number;
  pendingVersion?: string;
  apply: { status: number; body: unknown };
  discard?: { status: number; body: unknown; afterVersion?: string };
};

function wire(server: Server) {
  apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === `/api/website/publish-status?app=${encodeURIComponent(SITE_KEY)}`) {
      return response({ pending: server.pending, published: 0, last_published_at: null });
    }
    if (path === `/api/website/pending?app=${encodeURIComponent(SITE_KEY)}`) {
      return response({
        items: Array.from({ length: server.pending }, (_, i) => ({
          id: `edit-${i + 1}`,
          updated_at: server.pendingVersion ?? `version-${i + 1}`,
          selector: `h${i + 1}`,
          kind: "text",
          summary: "Text edited",
          detail: `New words ${i + 1}`,
          status: "new",
        })),
      });
    }
    if (path === "/api/website/site-edits/apply" && init?.method === "POST") {
      return response(server.apply.body, server.apply.status);
    }
    if (path === "/api/website/discard" && init?.method === "POST") {
      if (server.discard?.afterVersion) server.pendingVersion = server.discard.afterVersion;
      return response(server.discard?.body ?? { discarded: 1 }, server.discard?.status ?? 200);
    }
    return response({});
  });
}

function Harness({
  onSiteEditsApplied,
  siteEditsApp,
  publish,
  publishable,
}: {
  onSiteEditsApplied: (r: { applied: number; remaining: number; conductorRunId: string | null }) => void;
  siteEditsApp: string | null;
  publish: SitePublishOnRequest | null;
  publishable: boolean;
}) {
  const [applying, setApplying] = useState(false);
  return (
    <PublishPopover
      appUrl="https://5173-sbx.e2b.app"
      appHost="5173-sbx.e2b.app"
      publishable={publishable}
      site={{ liveUrl: "https://a.zaviagent.com", status: "live" }}
      sitePublish={publish}
      siteEditsApp={siteEditsApp}
      siteEditsApplying={applying}
      onSiteEditsApplied={(r) => {
        onSiteEditsApplied(r);
        if (r.applied > 0) setApplying(true);
      }}
      onGetDomain={() => {}}
      onClose={() => {}}
    />
  );
}

function view(onSiteEditsApplied = vi.fn(), siteEditsApp: string | null = SITE_KEY, publish: SitePublishOnRequest | null = sitePublish) {
  render(<Harness onSiteEditsApplied={onSiteEditsApplied} siteEditsApp={siteEditsApp} publish={publish} publishable={publish === null} />);
  return onSiteEditsApplied;
}

const calls = (path: string) => apiFetch.mock.calls.filter(([p]) => p === path);

describe("Publish on a site with inline edits", () => {
  it("keeps Publish available next to Apply, and says publishing leaves the edits out", async () => {
    wire({ pending: 2, apply: { status: 200, body: { applied: 2, remaining: 0, conductor_run_id: "run-9" } } });
    view();
    expect(await screen.findByRole("button", { name: "Apply 2 edits" })).toBeTruthy();
    expect(screen.getByText("2 edits not in the site's code yet")).toBeTruthy();
    expect(screen.getByText(SITE_EDITS_APPLY_HINT)).toBeTruthy();
    expect(SITE_EDITS_APPLY_HINT).toMatch(/leaves these edits out/);
    const publish = screen.getByRole("button", { name: "Publish changes" }) as HTMLButtonElement;
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);
    await waitFor(() => expect(calls(`/api/workspace/autopilot/sites/${sitePublish.siteId}/publish`)).toHaveLength(1));
    expect(calls("/api/website/site-edits/apply")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /edits not in the site's code yet/ }));
    expect(await screen.findByText("New words 2")).toBeTruthy();
  });

  it("Apply sends the drafts once and stays applying while the drafts are still being written", async () => {
    wire({ pending: 2, apply: { status: 200, body: { applied: 2, remaining: 0, conductor_run_id: "run-9" } } });
    const applied = view();
    fireEvent.click(await screen.findByRole("button", { name: "Apply 2 edits" }));
    await waitFor(() => expect(applied).toHaveBeenCalledWith({ applied: 2, remaining: 0, conductorRunId: "run-9" }));
    const applying = (await screen.findByRole("button", { name: "Applying…" })) as HTMLButtonElement;
    expect(applying.disabled).toBe(true);
    expect(screen.getByText(SITE_EDITS_APPLYING_HINT)).toBeTruthy();
    fireEvent.click(applying);
    expect(screen.queryByRole("button", { name: /^Apply \d/ })).toBeNull();
    expect(calls("/api/website/site-edits/apply").map(([, i]) => JSON.parse((i as { body: string }).body))).toEqual([{ app_id: SITE_KEY }]);
    expect((screen.getByRole("button", { name: "Publish changes" }) as HTMLButtonElement).disabled).toBe(false);
    expect(calls("/api/website/publish")).toHaveLength(0);
  });

  it("shows Publishing, not Apply, while the site publishes", async () => {
    wire({ pending: 2, apply: { status: 200, body: {} } });
    view(vi.fn(), SITE_KEY, { ...sitePublish, status: "publishing" });
    await screen.findByRole("button", { name: /Publishing/ });
    await screen.findByText("2 edits not in the site's code yet");
    expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
  });

  it("a site without on-request publish keeps its header and never publishes site drafts under the sandbox host", async () => {
    wire({ pending: 2, apply: { status: 200, body: {} } });
    view(vi.fn(), SITE_KEY, null);
    await screen.findByText("2 edits not in the site's code yet");
    expect(screen.getByText("Live on the web")).toBeTruthy();
    expect(screen.queryByText(/unpublished change/)).toBeNull();
    expect(screen.queryByText("Your website is up to date")).toBeNull();
    const publish = screen.getByRole("button", { name: /Publish|Up to date/ }) as HTMLButtonElement;
    if (!publish.disabled) fireEvent.click(publish);
    const confirm = screen.queryByRole("button", { name: "Publish now" });
    if (confirm) fireEvent.click(confirm);
    await new Promise((r) => setTimeout(r, 0));
    expect(apiFetch.mock.calls.some(([p, i]) => p === "/api/website/publish" && String((i as { body?: string })?.body).includes("5173-sbx.e2b.app"))).toBe(false);
  });

  it("a site without on-request publish and no drafts keeps the previous header", async () => {
    wire({ pending: 0, apply: { status: 200, body: {} } });
    view(vi.fn(), SITE_KEY, null);
    await waitFor(() => expect(calls(`/api/website/publish-status?app=${encodeURIComponent(SITE_KEY)}`).length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("Live on the web")).toBeTruthy();
    expect(screen.queryByText("Your website is up to date")).toBeNull();
  });

  it("a refused apply keeps the drafts and says why", async () => {
    wire({
      pending: 2,
      apply: {
        status: 409,
        body: { error: { code: "build_already_in_progress", message: "Another build or change is already running for this workspace." }, kept: 2 },
      },
    });
    const applied = view();
    fireEvent.click(await screen.findByRole("button", { name: "Apply 2 edits" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Another build or change is already running");
    expect(applied).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Apply 2 edits" })).toBeTruthy();
    expect(screen.getByText("2 edits not in the site's code yet")).toBeTruthy();
  });

  it("discards one reviewed edit with the version that was displayed", async () => {
    wire({ pending: 1, apply: { status: 200, body: {} } });
    view();
    fireEvent.click(await screen.findByRole("button", { name: /edit not in the site's code yet/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard change: Text edited" }));
    await waitFor(() => expect(calls("/api/website/discard")).toHaveLength(1));
    const [, init] = calls("/api/website/discard")[0];
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      app_id: SITE_KEY,
      selector: "h1",
      expected: { id: "edit-1", updated_at: "version-1" },
    });
  });

  it("refreshes a stale reviewed edit after a discard conflict before retrying", async () => {
    const server: Server = {
      pending: 1,
      pendingVersion: "version-old",
      apply: { status: 200, body: {} },
      discard: {
        status: 409,
        body: { error: { message: "That change was edited somewhere else. Reload and try again." } },
        afterVersion: "version-new",
      },
    };
    wire(server);
    view();
    fireEvent.click(await screen.findByRole("button", { name: /edit not in the site's code yet/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard change: Text edited" }));
    expect((await screen.findByRole("alert")).textContent).toContain("edited somewhere else");
    await waitFor(() => expect(calls(`/api/website/pending?app=${encodeURIComponent(SITE_KEY)}`)).toHaveLength(2));
    server.discard = { status: 200, body: { discarded: 1 } };
    fireEvent.click(screen.getByRole("button", { name: "Discard change: Text edited" }));
    await waitFor(() => expect(calls("/api/website/discard")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    const [, init] = calls("/api/website/discard")[1];
    expect(JSON.parse((init as { body: string }).body).expected).toEqual({ id: "edit-1", updated_at: "version-new" });
  });

  it("a site with no drafts publishes as before", async () => {
    wire({ pending: 0, apply: { status: 200, body: {} } });
    view();
    await screen.findByRole("button", { name: "Publish changes" });
    expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
  });

  it("never reads a site's drafts under the sandbox host", async () => {
    wire({ pending: 0, apply: { status: 200, body: {} } });
    view(vi.fn(), null);
    await screen.findByRole("button", { name: "Publish changes" });
    expect(apiFetch.mock.calls.some(([p]) => String(p).includes("5173-sbx.e2b.app"))).toBe(false);
    expect(apiFetch.mock.calls.some(([p]) => String(p).startsWith("/api/website/publish-status"))).toBe(false);
  });
});

describe("after the apply's change finishes", () => {
  it("re-reads the counts, so Apply is never offered for edits already in the code", async () => {
    const server: Server = { pending: 2, apply: { status: 200, body: {} } };
    wire(server);
    const props = { appUrl: "https://5173-sbx.e2b.app", appHost: "5173-sbx.e2b.app", publishable: false, site: { liveUrl: "https://a.zaviagent.com", status: "live" }, sitePublish, siteEditsApp: SITE_KEY, onGetDomain: () => {}, onClose: () => {} } as const;
    const { rerender } = render(<PublishPopover {...props} siteEditsApplying />);
    await screen.findByRole("button", { name: "Applying…" });
    server.pending = 0;
    rerender(<PublishPopover {...props} siteEditsApplying={false} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Apply \d/ })).toBeNull());
    expect(screen.queryByText(/edits not in the site's code yet/)).toBeNull();
  });
});
