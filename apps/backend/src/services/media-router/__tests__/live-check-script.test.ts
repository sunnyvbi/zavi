import { beforeAll, describe, expect, it, vi } from "vitest";
import { activeRoute } from "../table";
import { MEDIA_TASKS } from "../types";

const liveCheckScript: string = "../../../../scripts/media-router-live-check.mjs";
type LiveCheck = {
  ACTIVE_ROUTES: Record<string, string>;
  PRICE_IDS: string[];
  main: (opts: { fetch: unknown; key: string; argv: string[]; log: (l: string) => void; sleep: () => Promise<void> }) => Promise<number>;
};
let script: LiveCheck;
beforeAll(async () => {
  script = (await import(liveCheckScript)) as LiveCheck;
});

type Call = { url: string; method: string; body?: string };

function fakeFal(opts: { pricingStatus?: number; pricingThrows?: boolean; pricingBody?: string; unpriced?: string[] } = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    if (url.startsWith("https://api.fal.ai/v1/models/pricing")) {
      if (opts.pricingThrows) throw new Error("getaddrinfo ENOTFOUND");
      const status = opts.pricingStatus ?? 200;
      if (status !== 200) return new Response('{"detail":"Invalid key"}', { status });
      if (opts.pricingBody !== undefined) return new Response(opts.pricingBody, { status });
      const asked = new URL(url).searchParams.getAll("endpoint_id").filter((id) => !(opts.unpriced ?? []).includes(id));
      return Response.json({ prices: asked.map((endpoint_id) => ({ endpoint_id, unit_price: 0.05, unit: "second", currency: "USD" })) });
    }
    if (url.startsWith("https://queue.fal.run/") && init.method === "POST") {
      const id = url.slice("https://queue.fal.run/".length);
      return Response.json({ status_url: `https://status/${id}`, response_url: `https://result/${id}` });
    }
    if (url.startsWith("https://status/")) return Response.json({ status: "COMPLETED" });
    if (url.startsWith("https://result/")) {
      const id = url.slice("https://result/".length);
      return Response.json({ video: { url: `https://cdn/${id}` } });
    }
    if (url.startsWith("https://cdn/")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } });
    throw new Error(`unexpected fetch ${url}`);
  });
  return { fetch, calls };
}

const quiet = () => undefined;
const noSleep = async () => undefined;

function pricedIds(calls: Call[]): string[] {
  const priced = calls.find((c) => c.url.startsWith("https://api.fal.ai/v1/models/pricing"));
  return priced ? new URL(priced.url).searchParams.getAll("endpoint_id") : [];
}

function generatedIds(calls: Call[]): string[] {
  return calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/")).map((c) => c.url.slice("https://queue.fal.run/".length));
}

describe("media-router live check covers the routes production actually calls", () => {
  it.each([...MEDIA_TASKS])("%s: the script's active route is the table's active route, and it is a fal route", (task) => {
    const route = activeRoute(task);
    expect(route.vendor).toBe("fal");
    expect(script.ACTIVE_ROUTES[task]).toBe(route.model);
  });

  it("prices and generates every active route of every task, with real chained inputs", async () => {
    const f = fakeFal();
    const code = await script.main({ fetch: f.fetch, key: "k", argv: ["--generate"], log: quiet, sleep: noSleep });
    const priced = pricedIds(f.calls);
    const generated = generatedIds(f.calls);
    for (const task of MEDIA_TASKS) {
      const model = activeRoute(task).model;
      expect(priced, `${task} priced`).toContain(model);
      expect(generated, `${task} generated`).toContain(model);
    }
    const editBody = JSON.parse(f.calls.find((c) => c.method === "POST" && c.url.endsWith(activeRoute("video.edit").model))!.body!);
    expect(editBody.reference_video_urls).toEqual([`https://cdn/${activeRoute("video.broll").model}`]);
    const imageEditBody = JSON.parse(f.calls.find((c) => c.method === "POST" && c.url.endsWith(activeRoute("image.edit").model))!.body!);
    expect(imageEditBody.image_urls).toEqual([`https://cdn/${activeRoute("image.photo").model}`]);
    const avatarBody = JSON.parse(f.calls.find((c) => c.method === "POST" && c.url.endsWith(activeRoute("video.talking_head").model))!.body!);
    expect(avatarBody.audio_url).toBe(`https://cdn/${activeRoute("audio.voiceover").model}`);
    expect(code).toBe(0);
  });

  it("prices-only mode still prices every active route and generates nothing", async () => {
    const f = fakeFal();
    await expect(script.main({ fetch: f.fetch, key: "k", argv: [], log: quiet, sleep: noSleep })).resolves.toBe(0);
    for (const task of MEDIA_TASKS) expect(pricedIds(f.calls)).toContain(activeRoute(task).model);
    expect(generatedIds(f.calls)).toEqual([]);
  });
});

describe("media-router live check fails loudly when pricing fails", () => {
  it.each([401, 403, 500])("a %s from the pricing call exits non-zero and spends nothing", async (status) => {
    const f = fakeFal({ pricingStatus: status });
    await expect(script.main({ fetch: f.fetch, key: "bad", argv: ["--generate"], log: quiet, sleep: noSleep })).resolves.toBe(1);
    expect(generatedIds(f.calls)).toEqual([]);
  });

  it("prices-only mode prints a PASS with the price for every active task", async () => {
    const f = fakeFal();
    const lines: string[] = [];
    const code = await script.main({ fetch: f.fetch, key: "k", argv: [], log: (l) => lines.push(l), sleep: noSleep });
    expect(code).toBe(0);
    for (const task of MEDIA_TASKS) {
      expect(lines, task).toContain(`PASS ${task} ${activeRoute(task).model} 0.05 USD per second`);
    }
  });

  it.each(["video.broll", "video.talking_head", "image.photo"] as const)("no price for the %s route exits non-zero and spends nothing", async (task) => {
    const f = fakeFal({ unpriced: [activeRoute(task).model] });
    const lines: string[] = [];
    await expect(script.main({ fetch: f.fetch, key: "k", argv: ["--generate"], log: (l) => lines.push(l), sleep: noSleep })).resolves.toBe(1);
    expect(lines).toContain(`FAIL ${task} ${activeRoute(task).model} no price returned`);
    expect(generatedIds(f.calls)).toEqual([]);
  });

  it.each(['{"prices":[]}', "not json", '{"detail":"ok"}'])("a pricing reply of %s exits non-zero in prices-only mode", async (body) => {
    const f = fakeFal({ pricingBody: body });
    await expect(script.main({ fetch: f.fetch, key: "k", argv: [], log: quiet, sleep: noSleep })).resolves.toBe(1);
  });

  it("a bad key in prices-only mode exits non-zero", async () => {
    const f = fakeFal({ pricingStatus: 401 });
    await expect(script.main({ fetch: f.fetch, key: "bad", argv: [], log: quiet, sleep: noSleep })).resolves.toBe(1);
  });

  it("a pricing call that never answers exits non-zero", async () => {
    const f = fakeFal({ pricingThrows: true });
    await expect(script.main({ fetch: f.fetch, key: "k", argv: [], log: quiet, sleep: noSleep })).resolves.toBe(1);
  });

  it("a missing key exits non-zero without calling fal", async () => {
    const f = fakeFal();
    await expect(script.main({ fetch: f.fetch, key: "", argv: [], log: quiet, sleep: noSleep })).resolves.toBe(1);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
