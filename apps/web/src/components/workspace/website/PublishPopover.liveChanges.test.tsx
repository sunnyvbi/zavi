// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/components/ui/toast", () => ({ toast: { add: vi.fn(), update: vi.fn(), close: vi.fn() } }));
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var" } }));

import { PublishPopover, type SitePublishOnRequest } from "./PublishPopover";
import { readBuildSite, readSiteUnpublished } from "@/lib/workspace/useBuildPreview";
import { SITE_CHANGES_READY_TITLE } from "@/lib/workspace/buildFraming";
import { resolveBuildRefine, BUILD_REFINE_CONFIRMATION } from "./websiteChatEdit";

const SITE_HOST = "bakery-693dfbdb.zaviagent.com";
const SITE_PUBLISH = "/api/workspace/autopilot/sites/site-1/publish";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const posts = () =>
  apiFetch.mock.calls.filter(([url, init]) => url === SITE_PUBLISH && (init as RequestInit | undefined)?.method === "POST");

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

async function livePopover(over: Partial<SitePublishOnRequest> = {}) {
  apiFetch.mockImplementation(async (url: string) => (url === SITE_PUBLISH ? ok({ ok: true, conductor_run_id: "run-21" }) : ok({})));
  const onStarted = vi.fn();
  render(
    <div data-testid="popover">
      <PublishPopover
        onGetDomain={() => {}}
        onClose={() => {}}
        appUrl="https://5173-sbx.e2b.app"
        appHost="5173-sbx.e2b.app"
        publishable={false}
        ownBuildApp
        site={{ liveUrl: `https://${SITE_HOST}`, status: "live" }}
        sitePublish={{
          siteId: "site-1",
          hostname: SITE_HOST,
          built: true,
          status: "none",
          changes: {
            count: 2,
            items: [
              { id: "e2", kind: "edit", message: "Add a gluten-free badge next to the sourdough" },
              { id: "u1", kind: "undo", message: null },
            ],
          },
          onStarted,
          ...over,
        }}
      />
    </div>,
  );
  await waitFor(() => expect(screen.queryByLabelText("Loading publish options")).toBeNull());
  return { pop: within(screen.getByTestId("popover")), onStarted };
}

describe("a live site with changes waiting for Publish", () => {
  it("says Changes ready to publish, lists what changed, and Publish changes starts exactly one publish", async () => {
    const { pop, onStarted } = await livePopover();
    expect(pop.getByRole("heading", { name: SITE_CHANGES_READY_TITLE })).toBeTruthy();
    expect(screen.getByTestId("popover").textContent).toMatch(/2 changes are in your preview/);
    expect(screen.getByTestId("popover").textContent).toMatch(/last published version/);
    const list = pop.getByRole("list", { name: "Changes ready to publish" });
    expect(within(list).getByText("Add a gluten-free badge next to the sourdough")).toBeTruthy();
    expect(within(list).getByText("Undid a change")).toBeTruthy();
    const button = pop.getByRole("button", { name: "Publish changes" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
  });

  it("while that publish runs it shows progress, then a failure keeps the live version and offers Try again", async () => {
    const running = await livePopover({ status: "publishing" });
    expect(running.pop.getByRole("heading", { name: "Publishing…" })).toBeTruthy();
    cleanup();
    const failed = await livePopover({ status: "failed", reason: null });
    expect(failed.pop.getByRole("heading", { name: "Publishing didn't finish" })).toBeTruthy();
    expect(screen.getByTestId("popover").textContent).toMatch(/still shows the last published version/);
    expect(failed.pop.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("comparing and taking back waiting changes", () => {
  it("links to the live site to compare with the preview", async () => {
    const { pop } = await livePopover();
    const link = pop.getByRole("link", { name: /Compare with live site/ });
    expect(link.getAttribute("href")).toBe(`https://${SITE_HOST}`);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("an undo that names its change reads as that undo", async () => {
    const { pop } = await livePopover({
      changes: { count: 1, items: [{ id: "u2", kind: "undo", message: "Undo: Add a gluten-free badge" }] },
    });
    expect(within(pop.getByRole("list", { name: "Changes ready to publish" })).getByText("Undo: Add a gluten-free badge")).toBeTruthy();
  });

  it("Undo takes back the newest waiting change only, then refreshes the list", async () => {
    const onUndoChange = vi.fn(async () => ({ error: null, notice: "The change was undone in your preview. Click Publish to put it live." }));
    const onRefresh = vi.fn();
    const { pop } = await livePopover({ onUndoChange, onRefresh });
    const undos = pop.getAllByRole("button", { name: /^Undo:/ });
    expect(undos).toHaveLength(1);
    expect(undos[0].getAttribute("aria-label")).toBe("Undo: Add a gluten-free badge next to the sourdough");
    fireEvent.click(undos[0]);
    await waitFor(() => expect(onUndoChange).toHaveBeenCalledWith("e2"));
    expect((await pop.findByRole("status")).textContent).toMatch(/undone in your preview/);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("a refused undo says why and changes nothing", async () => {
    const onUndoChange = vi.fn(async () => ({ error: "This change can't be undone any more, because your app changed after it.", notice: null }));
    const onRefresh = vi.fn();
    const { pop } = await livePopover({ onUndoChange, onRefresh });
    fireEvent.click(pop.getByRole("button", { name: /^Undo:/ }));
    expect((await pop.findByRole("alert")).textContent).toMatch(/can't be undone any more/);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("no Undo while a publish runs, or when the newest is itself an undo", async () => {
    const running = await livePopover({ status: "publishing", onUndoChange: vi.fn() });
    expect(running.pop.queryByRole("button", { name: /^Undo:/ })).toBeNull();
    cleanup();
    const undoFirst = await livePopover({
      onUndoChange: vi.fn(),
      changes: { count: 2, items: [{ id: "u1", kind: "undo", message: null }, { id: "e2", kind: "edit", message: "Add a badge" }] },
    });
    expect(undoFirst.pop.queryByRole("button", { name: /^Undo:/ })).toBeNull();
  });
});

describe("the build status block for a live site's waiting changes", () => {
  it("parses the count, the newest changes and the publish state; none waiting is null", () => {
    const parsed = readSiteUnpublished({
      count: 3,
      changes: [{ id: "e3", kind: "edit", at: "2026-10-02T12:00:00Z", message: "  Add a badge  " }, { id: 7 }],
      publish: { status: "publishing", started_at: "2026-10-02T12:01:00Z" },
    });
    expect(parsed).toMatchObject({ count: 3, changes: [{ id: "e3", kind: "edit", message: "Add a badge" }] });
    expect(parsed?.publish.status).toBe("publishing");
    expect(readSiteUnpublished({ count: 0, changes: [] })).toBeNull();
    expect(readSiteUnpublished(null)).toBeNull();
    expect(readSiteUnpublished("x")).toBeNull();
  });

  it("an unread state is kept as unknown, never as nothing waiting", () => {
    expect(readBuildSite({ id: "s1", status: "live", unpublished_changes_unknown: true })).toMatchObject({ unpublished: null, unpublishedUnknown: true });
    expect(readBuildSite({ id: "s1", status: "live" })).not.toHaveProperty("unpublishedUnknown");
  });
});

describe("the site chat's reply to a data-deleting edit", () => {
  it("says the stored data stays before the usual confirmation", async () => {
    const note = "One thing first: your site's saved data can't be deleted by a change yet.";
    const r = await resolveBuildRefine("remove the phone field and delete phone data", async () => ({ ok: true, note }));
    expect(r).toEqual({ handled: true, consumed: true, system: `${note} ${BUILD_REFINE_CONFIRMATION}` });
    const plain = await resolveBuildRefine("Add a badge", async () => ({ ok: true }));
    expect(plain.system).toBe(BUILD_REFINE_CONFIRMATION);
  });
});
