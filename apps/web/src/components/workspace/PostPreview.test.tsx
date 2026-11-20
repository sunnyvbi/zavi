// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const state: {
  rows: Array<{ slug: string; team_name?: string | null; connected_at?: string; team_id?: string }>;
  tenantId: string | null;
  snap: { username: string | null; created_at: string; connection_id?: string | null } | null;
} = { rows: [], tenantId: "tenant-1", snap: null };
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: (table: string) =>
      table === "connector_metadata"
        ? {
            select: () => ({
              eq: () => ({ in: (_c: string, slugs: string[]) => Promise.resolve({ data: state.rows.filter((r) => slugs.includes(r.slug)), error: null }) }),
            }),
          }
        : {
            select: () => {
              const q = { eq: () => q, order: () => q, limit: () => q, maybeSingle: () => Promise.resolve({ data: state.snap, error: null }) };
              return q;
            },
          },
  }),
}));
vi.mock("@/lib/active-tenant-client", () => ({
  getActiveTenantId: () => Promise.resolve(state.tenantId),
}));

import { PostPreview } from "./PostPreview";

const PATH = "73db45ff-457e-4541-bc8f-bdb625390204/9ff27fce-9f83-4c1a-9a1e-0b2c3d4e5f60.jpg";

beforeEach(() => {
  apiFetch.mockReset();
  state.rows = [];
  state.tenantId = "tenant-1";
  state.snap = null;
});

describe("PostPreview — image (carried over)", () => {
  it("renders the image from the route's `signed_url` field", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ signed_url: "https://sb.example/signed?t=1", expires_in: 600 }),
    });
    const { container } = render(
      <PostPreview channel="linkedin_image" payload={{ text: "hi", image_path: PATH }} />,
    );
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe("https://sb.example/signed?t=1"),
    );
  });

  it("asks for the image at the tenant-gated route with the path encoded", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ signed_url: "https://x/y" }) });
    render(<PostPreview channel="linkedin_image" payload={{ text: "hi", image_path: PATH }} />);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(`/api/chat/image-url?path=${encodeURIComponent(PATH)}`),
    );
  });

  it("still shows the copy when the image can't be signed", async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    const { container } = render(
      <PostPreview channel="linkedin_image" payload={{ text: "the copy", image_path: PATH }} />,
    );
    expect(await within(container).findByText("the copy")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("never fetches an image for a text channel", () => {
    const { container } = render(<PostPreview channel="linkedin" payload={{ text: "text only" }} />);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(within(container).getByText("text only")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("PostPreview — header", () => {
  it("names the platform and the connected account", async () => {
    state.rows = [{ slug: "linkedin_social", team_name: "Ravi Kumar" }];
    const { container } = render(<PostPreview channel="linkedin" payload={{ text: "hi" }} />);
    expect(within(container).getByText("LinkedIn")).toBeTruthy();
    expect(await within(container).findByText("· Ravi Kumar")).toBeTruthy();
    expect(within(container).queryByText(/^Not connected/)).toBeNull();
  });

  it("an Instagram connected only through Composio is connected, named from its last read", async () => {
    state.rows = [{ slug: "composio.instagram", team_name: null, team_id: "ca_current", connected_at: "2026-10-09T04:54:26Z" }];
    state.snap = { username: "amogh_zavi", created_at: "2026-10-19T05:42:16Z", connection_id: "ca_current" };
    const { container } = render(<PostPreview channel="instagram_image" payload={{ text: "hi" }} />);
    expect(await within(container).findByText("· @amogh_zavi")).toBeTruthy();
    expect(within(container).getByText("Publishes from @amogh_zavi when you approve")).toBeTruthy();
    expect(within(container).queryByText(/^Not connected/)).toBeNull();
  });

  it("never names an Instagram account read before the current connection", async () => {
    state.rows = [{ slug: "composio.instagram", team_name: null, connected_at: "2026-10-09T04:54:26Z" }];
    state.snap = { username: "testxup", created_at: "2026-10-02T06:25:32Z" };
    const { container } = render(<PostPreview channel="instagram_image" payload={{ text: "hi" }} />);
    await waitFor(() => expect(within(container).getByText("Publishes when you approve")).toBeTruthy());
    expect(within(container).queryByText(/testxup/)).toBeNull();
    expect(within(container).queryByText(/^Not connected/)).toBeNull();
  });

  it("a Reddit connected only through Composio is connected", async () => {
    state.rows = [{ slug: "composio.reddit", team_name: null }];
    const { container } = render(<PostPreview channel="reddit" payload={{ subreddit: "SaaS", title: "T", text: "b" }} />);
    await waitFor(() => expect(within(container).getByText("· r/SaaS")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 0));
    expect(within(container).queryByText(/^Not connected/)).toBeNull();
  });

  it("flags a channel whose publishing connector is not connected", async () => {
    state.rows = [{ slug: "x_social", team_name: "@zavi" }];
    const { container } = render(<PostPreview channel="reddit" payload={{ subreddit: "SaaS", title: "T", text: "b" }} />);
    expect(await within(container).findByText(/^Not connected/)).toBeTruthy();
    expect(within(container).getByText("· r/SaaS")).toBeTruthy();
  });
});

describe("PostPreview — caps, time, vendor note", () => {
  it("marks the overflow past the cap and shows n / cap", async () => {
    const { container } = render(<PostPreview channel="linkedin" payload={{ text: "a".repeat(3001) }} />);
    expect(within(container).getByTestId("overflow").textContent).toBe("a");
    expect(within(container).getByRole("alert").textContent).toMatch(/after 3000 characters/);
    expect(within(container).getByText("3001 / 3000")).toBeTruthy();
  });

  it("no marker under the cap", () => {
    const { container } = render(<PostPreview channel="x" payload={{ text: "short" }} />);
    expect(within(container).queryByTestId("overflow")).toBeNull();
    expect(within(container).getByText("5 / 280")).toBeTruthy();
  });

  it("says when it publishes", () => {
    const iso = "2099-01-02T09:00:00.000Z";
    const { container: a } = render(<PostPreview channel="linkedin" payload={{ text: "x" }} scheduledAt={iso} />);
    expect(within(a).getByText(/^Staged for your approval · publishes .*(2099|Jan)/)).toBeTruthy();
    const { container: b } = render(<PostPreview channel="linkedin" payload={{ text: "x" }} scheduledAt={null} />);
    expect(within(b).getByText("Publishes when you approve")).toBeTruthy();
  });

  it("shows the vendor-review note for channels the vendor has not cleared", () => {
    const { container } = render(
      <PostPreview channel="youtube_video" payload={{ text: "c", title: "t", video_path: PATH.replace(/\.jpg$/, ".mp4") }} />,
    );
    expect(within(container).queryByText(/Awaiting/)).toBeNull();
    const { container: ig } = render(
      <PostPreview channel="instagram_image" payload={{ text: "c", image_path: PATH }} />,
    );
    expect(within(ig).queryByText(/Awaiting/)).toBeNull();
    const { container: li } = render(<PostPreview channel="linkedin" payload={{ text: "c" }} />);
    expect(within(li).queryByText(/Awaiting/)).toBeNull();
  });
});

describe("PostPreview — X", () => {
  it("counts a URL as 23 and an emoji as 2, and marks overflow by the weighted count", () => {
    const text = "a".repeat(250) + " https://trycoupleapp.com/a/very/long/path 🎉";
    const { container } = render(<PostPreview channel="x" payload={{ text }} />);
    expect(within(container).getByText("277 / 280")).toBeTruthy();
    expect(within(container).queryByRole("alert")).toBeNull();
    expect(within(container).getByText("Links to trycoupleapp.com")).toBeTruthy();

    const over = "a".repeat(279) + "🎉";
    const { container: c2 } = render(<PostPreview channel="x" payload={{ text: over }} />);
    expect(within(c2).getByText("281 / 280")).toBeTruthy();
    expect(within(c2).getByRole("alert").textContent).toMatch(/counts a link as 23/);
    expect(within(c2).getByTestId("overflow").textContent).toBe("🎉");
  });

  it("renders thread parts as numbered items with their own counters", () => {
    const { container } = render(
      <PostPreview channel="x" payload={{ text: "root", thread: ["second", "third"] }} />,
    );
    const list = within(container).getByRole("list", { name: "Thread parts" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toMatch(/^2\/3second6 \/ 280$/);
    expect(items[1].textContent).toMatch(/^3\/3third5 \/ 280$/);
    expect(within(container).getByText("Thread · 3 posts")).toBeTruthy();
  });

  it("ignores a thread on a non-X channel", () => {
    const { container } = render(
      <PostPreview channel="linkedin" payload={{ text: "root", thread: ["x"] }} />,
    );
    expect(within(container).queryByRole("list", { name: "Thread parts" })).toBeNull();
  });

  it("the not-connected pill is a Connect button", async () => {
    state.rows = [];
    const { container } = render(<PostPreview channel="x" payload={{ text: "hi" }} />);
    const btn = await within(container).findByRole("button", { name: /Not connected · Connect X/ });
    expect(btn).toBeTruthy();
  });
});

describe("PostPreview — editable", () => {
  it("reports text and thread edits", () => {
    const onEdit = vi.fn();
    const { container } = render(
      <PostPreview channel="x" payload={{ text: "root", thread: ["two"] }} onEdit={onEdit} />,
    );
    const text = within(container).getByLabelText("Post text") as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: "root!" } });
    expect(onEdit).toHaveBeenLastCalledWith({ text: "root!", thread: ["two"] });
    const part = within(container).getByLabelText("Thread part 2") as HTMLTextAreaElement;
    fireEvent.change(part, { target: { value: "two!" } });
    expect(onEdit).toHaveBeenLastCalledWith({ text: "root", thread: ["two!"] });
  });
});

describe("PostPreview — X media", () => {
  it("x_image fetches and shows the signed image", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ signed_url: "https://sb.example/signed?t=2", expires_in: 600 }) });
    const { container } = render(<PostPreview channel="x_image" payload={{ text: "pic", image_path: PATH }} />);
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("https://sb.example/signed?t=2"));
    expect(apiFetch).toHaveBeenCalledWith(`/api/chat/image-url?path=${encodeURIComponent(PATH)}`);
    expect(within(container).getByText("3 / 280")).toBeTruthy();
  });

  it("x_video shows the attachment line and counts X-style", () => {
    const { container } = render(
      <PostPreview channel="x_video" payload={{ text: "clip 🎉", video_path: `${PATH.split("/")[0]}/9ff27fce-9f83-4c1a-9a1e-0b2c3d4e5f60.mp4` }} />,
    );
    expect(within(container).getByText(/Video attached/)).toBeTruthy();
    expect(within(container).getByText("7 / 280")).toBeTruthy();
  });
});

describe("PostPreview — reconnect identity", () => {
  it("does not promise either account when publishing could use the native backup", async () => {
    state.rows = [
      { slug: "instagram_social", team_name: "@old_native" },
      { slug: "composio.instagram", team_id: "ca_new" },
    ];
    state.snap = { username: "current", created_at: "2026-10-19T12:00:00Z", connection_id: "ca_new" };
    const { container } = render(<PostPreview channel="instagram_image" payload={{ text: "hi" }} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(container).queryByText(/@current/)).toBeNull();
    expect(within(container).queryByText(/old_native/)).toBeNull();
  });

  it.each([
    { connected_at: "2026-10-19T10:00:00Z", captured: "2026-10-19T11:00:00+02:00" },
    { connected_at: undefined, captured: "2026-10-19T12:00:00Z" },
    { connected_at: "invalid", captured: "2026-10-19T12:00:00Z" },
  ])("does not trust an unverified legacy handle (%j)", async ({ connected_at, captured }) => {
    state.rows = [{ slug: "composio.instagram", connected_at }];
    state.snap = { username: "stale", created_at: captured };
    const { container } = render(<PostPreview channel="instagram_image" payload={{ text: "hi" }} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(container).queryByText(/@stale/)).toBeNull();
  });

  it("rejects a read from the old connection even if its capture time is newer", async () => {
    state.rows = [{ slug: "composio.instagram", team_id: "ca_new", connected_at: "2026-10-19T10:00:00Z" }];
    state.snap = { username: "stale", created_at: "2026-10-19T12:00:00Z", connection_id: "ca_old" };
    const { container } = render(<PostPreview channel="instagram_image" payload={{ text: "hi" }} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(container).queryByText(/@stale/)).toBeNull();
  });
});
