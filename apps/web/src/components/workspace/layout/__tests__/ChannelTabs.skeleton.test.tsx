// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChannelSettingsTab } from "../ChannelTabs";
import { PLATFORMS } from "../../actions/platforms";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const flush = async (ticks = 16) => {
  await act(async () => {
    for (let i = 0; i < ticks; i += 1) await Promise.resolve();
  });
};

const fieldsFor = (slug: string) => PLATFORMS[slug].settings ?? [];

const gate = new Map<string, (ok: boolean, body: unknown) => void>();

function hangEveryRead() {
  gate.clear();
  apiFetch.mockImplementation(
    (path: string) =>
      new Promise((res) => {
        gate.set(String(path), (ok, body) =>
          res({ ok, status: ok ? 200 : 500, json: async () => body }),
        );
      }),
  );
}

const settle = async (slug: string, ok: boolean, body: unknown) => {
  const resolve = gate.get(`/api/channels/${slug}/settings`);
  if (!resolve) throw new Error(`no read in flight for ${slug}`);
  resolve(ok, body);
  await flush();
};

const skeleton = () => screen.queryByTestId("channel-settings-skeleton");

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  gate.clear();
});

describe("the settings tab while the read is in flight", () => {
  it("draws one placeholder card per declared field, and the loaded tab draws exactly as many", async () => {
    hangEveryRead();
    const fields = fieldsFor("google_ads");
    expect(fields.length).toBeGreaterThan(1);

    const { container } = render(
      <ChannelSettingsTab slug="google_ads" fields={fields} />,
    );
    await flush();

    const placeholder = skeleton();
    expect(placeholder).not.toBeNull();
    expect(placeholder!.querySelectorAll("section")).toHaveLength(fields.length);

    await settle("google_ads", true, { fields: {} });

    expect(skeleton()).toBeNull();
    expect(container.querySelectorAll("section")).toHaveLength(fields.length);
  });

  it("offers no control it cannot honour yet", async () => {
    hangEveryRead();
    render(
      <ChannelSettingsTab slug="google_ads" fields={fieldsFor("google_ads")} />,
    );
    await flush();

    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("announces the wait once, and hides every shimmer block from the reader", async () => {
    hangEveryRead();
    render(
      <ChannelSettingsTab slug="reddit_organic" fields={fieldsFor("reddit_organic")} />,
    );
    await flush();

    const placeholder = skeleton()!;
    expect(placeholder.getAttribute("role")).toBe("status");
    expect(placeholder.getAttribute("aria-busy")).toBe("true");
    expect(placeholder.textContent).toContain("Reading your settings…");

    const blocks = placeholder.querySelectorAll("span[aria-hidden]");
    expect(blocks.length).toBeGreaterThan(fieldsFor("reddit_organic").length);
  });

  it("stops at the refusal instead of shimmering forever", async () => {
    hangEveryRead();
    render(
      <ChannelSettingsTab slug="google_ads" fields={fieldsFor("google_ads")} />,
    );
    await flush();
    expect(skeleton()).not.toBeNull();

    await settle("google_ads", false, {});

    expect(skeleton()).toBeNull();
    expect(screen.getByText(/aren't available yet/)).toBeTruthy();
  });

  it("never paints the channel you left under the channel you opened", async () => {
    hangEveryRead();
    const { rerender } = render(
      <ChannelSettingsTab slug="reddit_organic" fields={fieldsFor("reddit_organic")} />,
    );
    await flush();

    rerender(<ChannelSettingsTab slug="google_ads" fields={fieldsFor("google_ads")} />);
    await flush();
    expect(skeleton()).not.toBeNull();

    await settle("google_ads", true, {
      fields: { negatives: [{ item: "free trial", status: "tracking" }] },
    });
    expect(skeleton()).toBeNull();
    expect(screen.getByText("free trial")).toBeTruthy();

    await settle("reddit_organic", true, {
      fields: { keywords: [{ item: "stale reddit keyword", status: "tracking" }] },
    });

    expect(screen.queryByText("stale reddit keyword")).toBeNull();
    expect(screen.getByText("free trial")).toBeTruthy();
  });
});
