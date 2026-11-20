import { describe, expect, it, vi } from "vitest";
import { dailyRowsOf, pinInfoOf, readPinterestDetail } from "../detail";

const ok = (data: unknown) => ({ ok: true, status: 200, error: null, data });

const LIST = {
  items: [
    { id: "p1", title: "The weekly math of renting", media: { media_type: "video", cover_image_url: "https://i.pinimg.com/videos/p1.jpg" } },
    { id: "p2", title: "", description: "Why gig drivers rent, not buy\nMore", media: { media_type: "image", images: { "150x150": { url: "https://i.pinimg.com/150x150/p2.jpg" } } } },
    { id: "p3", media: { media_type: "multiple_images", items: [{ images: { "150x150": { url: "https://i.pinimg.com/150x150/p3.jpg" } } }] } },
  ],
};

describe("pinterest pin detail", () => {
  it("reads title, format and a thumbnail for each listed pin", () => {
    const info = pinInfoOf({ response_data: LIST });
    expect(info.get("p1")).toEqual({ title: "The weekly math of renting", format: "video", image: "https://i.pinimg.com/videos/p1.jpg" });
    expect(info.get("p2")).toEqual({ title: "Why gig drivers rent, not buy", format: "image", image: "https://i.pinimg.com/150x150/p2.jpg" });
    expect(info.get("p3")).toEqual({ title: "Untitled pin", format: "image", image: "https://i.pinimg.com/150x150/p3.jpg" });
  });

  it("reads daily metrics from either analytics shape, oldest first", () => {
    const days = [
      { date: "2026-10-02", metrics: { IMPRESSION: 20, ENGAGEMENT: 2 } },
      { date: "2026-10-01", metrics: { IMPRESSION: 10, OUTBOUND_CLICK: 1, SAVE: 3 } },
    ];
    expect(dailyRowsOf({ all: { daily_metrics: days } })).toEqual([
      { date: "2026-10-01", impressions: 10, engagements: 0, clicks: 1, saves: 3 },
      { date: "2026-10-02", impressions: 20, engagements: 2, clicks: 0, saves: 0 },
    ]);
    expect(dailyRowsOf({ analytics: { all: { daily_metrics: days } } })).toHaveLength(2);
    expect(dailyRowsOf({ other: 1 })).toBeNull();
  });

  it("joins each window's top pins to the pin list and keeps going when the list fails", async () => {
    const exec = vi.fn(async (slug: string, args: Record<string, unknown>) => {
      if (slug === "PINTEREST_GET_ACCOUNT_ANALYTICS") return ok({ all: { daily_metrics: [{ date: "2026-10-01", metrics: { IMPRESSION: 5 } }] } });
      if (slug === "PINTEREST_LIST_PINS") return ok(LIST);
      return ok({ pins: [{ pin_id: "p1", metrics: { IMPRESSION: 857, ENGAGEMENT: 47 } }, { pin_id: "p9", metrics: { IMPRESSION: 3 } }], args });
    });
    const out = await readPinterestDetail(exec as never, new Date("2026-10-16T10:00:00Z"));
    expect(Object.keys(out.pins ?? {})).toEqual(["7", "14", "30"]);
    expect(out.pins?.["30"][0]).toMatchObject({ id: "p1", title: "The weekly math of renting", format: "video", impressions: 857, engagements: 47, url: "https://www.pinterest.com/pin/p1/" });
    expect(out.pins?.["30"][1]).toMatchObject({ id: "p9", title: "Pin", format: null, image: null });
    const analytics = exec.mock.calls.find((c) => c[0] === "PINTEREST_GET_ACCOUNT_ANALYTICS")![1];
    expect(analytics).toMatchObject({ start_date: "2026-08-17", end_date: "2026-10-15" });
    expect(out.daily).toHaveLength(1);

    exec.mockImplementation(async (slug: string) => (slug === "PINTEREST_LIST_PINS" ? { ok: false, status: 500, error: "boom", data: null } : ok({ pins: [{ pin_id: "p1", metrics: {} }] })) as never);
    const partial = await readPinterestDetail(exec as never);
    expect(partial.pins?.["7"][0]).toMatchObject({ id: "p1", title: "Pin" });
    expect(partial.daily).toBeNull();
    expect(partial.daily_error).toBe("unexpected response shape");
  });
});
