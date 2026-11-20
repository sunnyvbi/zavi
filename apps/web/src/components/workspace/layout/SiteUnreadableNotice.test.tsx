// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  cleanDomainInput,
  shouldShowSiteNotice,
  SiteUnreadableNotice,
  type SiteReadState,
} from "./SiteUnreadableNotice";

const apiFetch = vi.hoisted(() => vi.fn());
const toastAdd = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/components/ui/toast", () => ({ toast: { add: toastAdd } }));

const UNREAD: SiteReadState = { state: "error", site: "https://agentkey.io", error_code: "seo_site_unreachable" };
const idle = [{ last_run_at: null, work_state: "idle" }];
const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  apiFetch.mockReset();
  toastAdd.mockReset();
});
afterEach(cleanup);

describe("shouldShowSiteNotice", () => {
  it("shows only for an unread site with no cards and no channel run yet", () => {
    expect(shouldShowSiteNotice(UNREAD, 0, idle)).toBe(true);
    expect(shouldShowSiteNotice({ ...UNREAD, state: "ok" }, 0, idle)).toBe(false);
    expect(shouldShowSiteNotice({ ...UNREAD, state: "unknown" }, 0, idle)).toBe(false);
    expect(shouldShowSiteNotice(null, 0, idle)).toBe(false);
    expect(shouldShowSiteNotice(UNREAD, 2, idle)).toBe(false);
    expect(shouldShowSiteNotice(UNREAD, null, idle)).toBe(false);
    expect(shouldShowSiteNotice(UNREAD, 0, [{ last_run_at: "2026-10-20T10:00:00Z", work_state: "delivered" }])).toBe(false);
    expect(shouldShowSiteNotice(UNREAD, 0, [{ last_run_at: null, work_state: "running" }])).toBe(false);
  });
});

describe("cleanDomainInput", () => {
  it("accepts a domain or URL and returns its host", () => {
    expect(cleanDomainInput("acme.com")).toBe("acme.com");
    expect(cleanDomainInput(" https://www.Acme.co.uk/about ")).toBe("www.acme.co.uk");
  });
  it("rejects what is not a website address", () => {
    expect(cleanDomainInput("")).toBeNull();
    expect(cleanDomainInput("acme")).toBeNull();
    expect(cleanDomainInput("my company.com")).toBeNull();
    expect(cleanDomainInput("localhost:3000")).toBeNull();
  });
});

describe("SiteUnreadableNotice", () => {
  it("names the site, and Try again rescans and reloads once it reads", async () => {
    apiFetch.mockResolvedValue(
      res(200, { site_read: { state: "ok", site: "https://agentkey.io", error_code: null }, first_run: { ran: true } }),
    );
    const onDone = vi.fn();
    render(<SiteUnreadableNotice siteRead={UNREAD} onDone={onDone} />);
    expect(screen.getByText("We couldn't read agentkey.io")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith("/api/channels/site-rescan", { method: "POST" });
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Read agentkey.io", description: "Your first channel run is starting." }),
    );
  });

  it("says so when the site still cannot be read", async () => {
    apiFetch.mockResolvedValue(res(200, { site_read: UNREAD, first_run: { ran: false } }));
    const onDone = vi.fn();
    render(<SiteUnreadableNotice siteRead={UNREAD} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Still couldn't read agentkey.io");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("shows the cooldown message from the server", async () => {
    apiFetch.mockResolvedValue(
      res(429, { error: { code: "rescan_cooldown", message: "We just checked your site. Try again in 40 seconds." } }),
    );
    render(<SiteUnreadableNotice siteRead={UNREAD} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Try again in 40 seconds");
  });

  it("Use a different URL validates, saves the domain fact, then rescans", async () => {
    apiFetch
      .mockResolvedValueOnce(res(200, { written: ["domain"] }))
      .mockResolvedValueOnce(res(200, { site_read: { state: "ok", site: "https://acme.com", error_code: null }, first_run: { ran: false } }));
    const onDone = vi.fn();
    render(<SiteUnreadableNotice siteRead={UNREAD} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Use a different URL" }));

    const input = screen.getByLabelText("Website address");
    fireEvent.change(input, { target: { value: "not a site" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and check" }));
    expect((await screen.findByRole("alert")).textContent).toContain("yourcompany.com");
    expect(apiFetch).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "https://acme.com/" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and check" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenNthCalledWith(1, "/api/connectors/company-facts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facts: [{ key: "domain", value: "acme.com" }] }),
    });
    expect(apiFetch).toHaveBeenNthCalledWith(2, "/api/channels/site-rescan", { method: "POST" });
  });

  it("does not rescan when the domain could not be saved", async () => {
    apiFetch.mockResolvedValueOnce(
      res(403, { error: { code: "not_admin", message: "Only a workspace owner or admin can change company facts." } }),
    );
    render(<SiteUnreadableNotice siteRead={UNREAD} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Use a different URL" }));
    fireEvent.change(screen.getByLabelText("Website address"), { target: { value: "acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and check" }));
    expect((await screen.findByRole("alert")).textContent).toContain("owner or admin");
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("asks for a website when none is on file", () => {
    render(
      <SiteUnreadableNotice siteRead={{ state: "error", site: null, error_code: "seo_site_unknown" }} onDone={() => {}} />,
    );
    expect(screen.getByText("Add your website so Zavi can start")).toBeTruthy();
    expect(screen.getByLabelText("Website address")).toBeTruthy();
  });
});

describe("SiteUnreadableNotice, a new URL not read yet", () => {
  it("does not claim the read failed, and offers to check it", () => {
    render(
      <SiteUnreadableNotice
        siteRead={{ state: "error", site: "https://new.example", error_code: "seo_site_unchecked" }}
        onDone={() => {}}
      />,
    );
    expect(screen.getByText("Zavi hasn't read new.example yet")).toBeTruthy();
    expect(screen.queryByText(/couldn't read/)).toBeNull();
    expect(screen.getByRole("button", { name: "Check it now" })).toBeTruthy();
  });
});

describe("SiteUnreadableNotice, a website saved from the notice", () => {
  const NONE: SiteReadState = { state: "error", site: null, error_code: "seo_site_unknown" };
  const save = () => {
    fireEvent.change(screen.getByLabelText("Website address"), { target: { value: "acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and check" }));
  };

  it("stops asking for a website once one is saved, even when the first read fails", async () => {
    apiFetch
      .mockResolvedValueOnce(res(200, { written: ["domain"] }))
      .mockResolvedValueOnce(res(200, { site_read: { state: "error", site: "https://acme.com", error_code: "seo_site_unreachable" } }));
    const onDone = vi.fn();
    render(<SiteUnreadableNotice siteRead={NONE} onDone={onDone} />);
    save();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Add your website so Zavi can start")).toBeNull();
    expect(screen.getByText("Zavi hasn't read acme.com yet")).toBeTruthy();
    expect(screen.queryByLabelText("Website address")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Still couldn't read acme.com");
  });

  it("stops asking when the check is refused for being too soon", async () => {
    apiFetch
      .mockResolvedValueOnce(res(200, { written: ["domain"] }))
      .mockResolvedValueOnce(res(429, { error: { message: "We just checked your site. Try again in 40 seconds." } }));
    const onDone = vi.fn();
    render(<SiteUnreadableNotice siteRead={NONE} onDone={onDone} />);
    save();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Add your website so Zavi can start")).toBeNull();
    expect(screen.getByRole("button", { name: "Check it now" })).toBeTruthy();
  });

  it("keeps asking when the save itself failed", async () => {
    apiFetch.mockResolvedValueOnce(res(400, { error: { message: "That address cannot be used." } }));
    const onDone = vi.fn();
    render(<SiteUnreadableNotice siteRead={NONE} onDone={onDone} />);
    save();
    expect((await screen.findByRole("alert")).textContent).toContain("cannot be used");
    expect(screen.getByText("Add your website so Zavi can start")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});
