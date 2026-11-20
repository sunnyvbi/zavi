// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  apiUrl: (path: string) => `http://api.test${path}`,
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { OldSiteFrozenNotice, RebuildOldSiteButton } from "./OldSiteRebuild";
import {
  isOldSiteFrozen,
  oldSiteFrozenFrom,
  OLD_SITE_FROZEN_FALLBACK,
  REBUILD_DATA_NOTE,
  REBUILD_OLD_SITE_LABEL,
  rebuildBuildHref,
  requestOldSiteRebuild,
} from "@/lib/workspace/oldSiteRebuild";

const NEW_BUILD = "0a1b2c3d-1111-4222-8333-444455556666";
const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe("oldSiteFrozenFrom", () => {
  it("reads the typed refusal and prefers the chat line", () => {
    const r = oldSiteFrozenFrom({ error: { code: "old_site_frozen", message: "m", chat: "the chat line" } });
    expect(r).toEqual({ kind: "old_site_frozen", message: "the chat line" });
    expect(isOldSiteFrozen(r)).toBe(true);
  });

  it("ignores other refusals and falls back to the shared words when the server sent none", () => {
    expect(oldSiteFrozenFrom({ error: { code: "site_required", message: "x" } })).toBeNull();
    expect(oldSiteFrozenFrom(null)).toBeNull();
    expect(oldSiteFrozenFrom({ error: { code: "old_site_frozen" } })?.message).toBe(OLD_SITE_FROZEN_FALLBACK);
  });

  it("the copy is plain words: no em dashes, no vendor names, says data does not move", () => {
    for (const text of [OLD_SITE_FROZEN_FALLBACK, REBUILD_DATA_NOTE]) {
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/render|neon|supabase|github/i);
      expect(text).toMatch(/does not move over/);
    }
  });
});

describe("requestOldSiteRebuild", () => {
  it("returns the new build, the 'already started' build, a 'starting' answer or a plain error", async () => {
    apiFetch.mockResolvedValueOnce(json({ ok: true, conductor_run_id: NEW_BUILD, already: false }));
    expect(await requestOldSiteRebuild()).toEqual({ kind: "started", conductorRunId: NEW_BUILD, already: false });
    expect(apiFetch).toHaveBeenCalledWith("/api/workspace/website/rebuild-old-site", expect.objectContaining({ method: "POST" }));

    apiFetch.mockResolvedValueOnce(json({ ok: true, conductor_run_id: NEW_BUILD, already: true }));
    expect(await requestOldSiteRebuild()).toEqual({ kind: "started", conductorRunId: NEW_BUILD, already: true });

    apiFetch.mockResolvedValueOnce(json({ ok: true, starting: true }, 202));
    expect(await requestOldSiteRebuild()).toEqual({ kind: "starting" });

    apiFetch.mockResolvedValueOnce(json({ error: { code: "build_already_in_progress", message: "Another build is running." } }, 409));
    expect(await requestOldSiteRebuild()).toEqual({ kind: "error", message: "Another build is running." });

    apiFetch.mockRejectedValueOnce(new Error("Failed to fetch"));
    expect((await requestOldSiteRebuild()).kind).toBe("error");
  });

  it("never follows a malformed build id", async () => {
    apiFetch.mockResolvedValueOnce(json({ ok: true, conductor_run_id: "../../admin" }));
    expect((await requestOldSiteRebuild()).kind).toBe("error");
    expect(rebuildBuildHref(NEW_BUILD)).toBe(`/workspace?tab=build&build=${NEW_BUILD}`);
  });
});

describe("RebuildOldSiteButton", () => {
  it("a double click sends ONE request and opens the new build once", async () => {
    let resolve!: (v: unknown) => void;
    apiFetch.mockImplementation(() => new Promise((r) => (resolve = r)));
    const onStarted = vi.fn();
    render(<RebuildOldSiteButton onStarted={onStarted} />);
    const button = screen.getByRole("button", { name: REBUILD_OLD_SITE_LABEL });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    resolve(json({ ok: true, conductor_run_id: NEW_BUILD, already: false }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(NEW_BUILD));
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("shows the data note, and an error re-enables the button with the reason", async () => {
    apiFetch.mockResolvedValueOnce(json({ error: { message: "You've reached today's build limit." } }, 429));
    render(<RebuildOldSiteButton onStarted={vi.fn()} />);
    expect(screen.getByText(REBUILD_DATA_NOTE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: REBUILD_OLD_SITE_LABEL }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/build limit/));
    expect((screen.getByRole("button", { name: REBUILD_OLD_SITE_LABEL }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("OldSiteFrozenNotice", () => {
  it("renders the reply with its Rebuild button", () => {
    render(<OldSiteFrozenNotice message="This site was made with our earlier builder." onStarted={vi.fn()} />);
    expect(screen.getByTestId("old-site-frozen-notice").textContent).toMatch(/earlier builder/);
    expect(screen.getByRole("button", { name: REBUILD_OLD_SITE_LABEL })).toBeTruthy();
  });
});
