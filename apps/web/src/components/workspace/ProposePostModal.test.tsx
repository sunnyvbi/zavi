// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { ProposePostModal } from "./ProposePostModal";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const PATH = "73db45ff-457e-4541-bc8f-bdb625390204/9ff27fce-9f83-4c1a-9a1e-0b2c3d4e5f60.jpg";

function caption(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector("textarea");
  if (!el) throw new Error("no caption textarea");
  return el as HTMLTextAreaElement;
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, decision_id: "dec-1" }),
  });
});

describe("ProposePostModal — caption default", () => {
  it("uses the copy it is handed, NOT the operator's instruction", () => {
    const { container } = render(
      <ProposePostModal
        open
        onClose={() => {}}
        initialCaption={"We cut churn 40% this quarter. Here is what changed."}
        imagePath={null}
      />,
    );
    expect(caption(container).value).toBe(
      "We cut churn 40% this quarter. Here is what changed.",
    );
    expect(caption(container).value).not.toMatch(/post this on my linkedin/i);
  });

  it("defaults to the image channel when an image is attached", () => {
    const { container } = render(
      <ProposePostModal open onClose={() => {}} initialCaption="hi" imagePath={PATH} />,
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("linkedin_image");
  });

  it("hides the image channel when there is no image to post", () => {
    const { container } = render(
      <ProposePostModal open onClose={() => {}} initialCaption="hi" imagePath={null} />,
    );
    const values = Array.from(container.querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(values).not.toContain("linkedin_image");
    expect(values).toEqual(["linkedin", "x", "reddit"]);
  });
});

describe("ProposePostModal — submit", () => {
  it("sends the image path with a linkedin_image post", async () => {
    const { container } = render(
      <ProposePostModal open onClose={() => {}} initialCaption="caption text" imagePath={PATH} />,
    );
    within(container).getByRole("button", { name: "Propose post" }).click();

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const [url, init] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/social/propose");
    expect(JSON.parse(init.body)).toEqual({
      channel: "linkedin_image",
      payload: { text: "caption text", image_path: PATH },
      scheduled_at: null,
    });
  });

  it("sends a picked schedule time as ISO, and none when the field is empty", async () => {
    const { container } = render(
      <ProposePostModal open onClose={() => {}} initialCaption="caption text" imagePath={null} />,
    );
    const when = container.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    expect(when).toBeTruthy();
    fireEvent.change(when, { target: { value: "2099-01-02T09:30" } });
    within(container).getByRole("button", { name: "Propose post" }).click();

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const body = JSON.parse(apiFetch.mock.calls[0][1].body);
    expect(body.scheduled_at).toBe(new Date("2099-01-02T09:30").toISOString());
  });

  it("refuses a past schedule time client-side and never posts", async () => {
    const { container } = render(
      <ProposePostModal open onClose={() => {}} initialCaption="caption text" imagePath={null} />,
    );
    const when = container.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    fireEvent.change(when, { target: { value: "2001-01-02T09:30" } });
    within(container).getByRole("button", { name: "Propose post" }).click();

    const alert = await within(container).findByRole("alert");
    expect(alert.textContent).toMatch(/future/i);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("tells the caller it staged, so the composer can clear", async () => {
    const onProposed = vi.fn();
    const { container } = render(
      <ProposePostModal
        open
        onClose={() => {}}
        initialCaption="caption text"
        imagePath={null}
        onProposed={onProposed}
      />,
    );
    within(container).getByRole("button", { name: "Propose post" }).click();
    await waitFor(() => expect(onProposed).toHaveBeenCalledWith("dec-1"));
  });

  it("surfaces a server refusal instead of pretending it staged", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "channel \"x\" is disabled" } }),
    });
    const onProposed = vi.fn();
    const { container } = render(
      <ProposePostModal
        open
        onClose={() => {}}
        initialCaption="caption text"
        imagePath={null}
        onProposed={onProposed}
      />,
    );
    within(container).getByRole("button", { name: "Propose post" }).click();

    const alert = await within(container).findByRole("alert");
    expect(alert.textContent).toMatch(/disabled/);
    expect(onProposed).not.toHaveBeenCalled();
  });
});
