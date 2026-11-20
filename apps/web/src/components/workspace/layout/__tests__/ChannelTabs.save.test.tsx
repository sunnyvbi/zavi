// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelSettingsTab } from "../ChannelTabs";
import { PLATFORMS } from "../../actions/platforms";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

type Rows = Record<string, unknown[]>;

const flush = async (ticks = 16) => {
  await act(async () => {
    for (let i = 0; i < ticks; i += 1) await Promise.resolve();
  });
};

const respond = (ok: boolean, status: number, body: unknown) =>
  Promise.resolve({ ok, status, json: async () => body });

function stubApi(
  fields: Rows,
  put: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: {} },
) {
  apiFetch.mockImplementation((path: string, init?: RequestInit) =>
    init?.method === "PUT"
      ? respond(put.ok, put.status, put.body)
      : respond(true, 200, { fields }),
  );
}

type PutItem = { item: string } & Record<string, unknown>;

const puts = (): { path: string; items: PutItem[] }[] =>
  apiFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([path, init]) => ({
      path: String(path),
      items: (JSON.parse(String((init as RequestInit).body)) as { items: PutItem[] }).items,
    }));

const sectionFor = (label: string) =>
  screen.getByText(label, { selector: "h4" }).closest("section") as HTMLElement;

const mount = (slug: "google_ads" | "reddit_organic") =>
  render(<ChannelSettingsTab slug={slug} fields={PLATFORMS[slug].settings ?? []} />);

const runSuggest = async () => {
  fireEvent.click(within(sectionFor("Keywords")).getByRole("button", { name: "Suggest" }));
  await flush();
};

const save = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await flush();
};

const REDDIT_KEYWORDS = [
  {
    id: "k1",
    item: "acme crm",
    item_type: "brand",
    status: "tracking",
    position: 0,
    note: "your own brand",
    detail: "acme.com",
    origin: "suggested",
  },
  {
    id: "k2",
    item: "best crm",
    item_type: "category",
    status: "suggested",
    position: 1,
    note: "Zavi found this in r/sales",
    detail: null,
    origin: "suggested",
  },
];

beforeEach(() => {
  apiFetch.mockReset();
  stubApi({});
});

afterEach(() => {
  try {
    const rogue = apiFetch.mock.calls
      .map(([path, init]) => ({
        path: String(path),
        body: String((init as RequestInit | undefined)?.body ?? ""),
      }))
      .filter((c) => c.body.includes('"status":"on"'));
    expect(
      rogue.map((c) => `${c.path} <- ${c.body}`),
      'A request sent status "on". The table CHECKs, the RPC validates and the route\'s zod enum all accept only suggested|tracking|paused|dismissed, so this 400s and nothing saves.',
    ).toEqual([]);
  } finally {
    cleanup();
  }
});

describe("the save bar says when there is something to save", () => {
  it("idle says when changes apply; an edit flips it to unsaved; a save clears it", async () => {
    stubApi({ keywords: REDDIT_KEYWORDS });
    mount("reddit_organic");
    await flush();
    const button = screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Applies on the next run\./)).toBeTruthy();
    expect(screen.queryByText("You have unsaved changes.")).toBeNull();

    const communities = sectionFor("Communities");
    fireEvent.change(within(communities).getByRole("textbox"), { target: { value: "r/startups" } });
    fireEvent.click(within(communities).getByRole("button", { name: "Add" }));
    await flush();
    expect(screen.getByText("You have unsaved changes.")).toBeTruthy();
    expect(button.disabled).toBe(false);

    await save();
    expect(puts()).toHaveLength(1);
    expect(puts()[0].path).toBe("/api/channels/reddit_organic/settings/communities");
    expect(screen.queryByText("You have unsaved changes.")).toBeNull();
  });
});

describe("a save speaks the backend's status vocabulary", () => {
  it("sends status tracking and origin custom for a row the founder typed", async () => {
    stubApi({});
    mount("google_ads");
    await flush();

    fireEvent.change(screen.getByLabelText("Add to Negative keywords"), {
      target: { value: "free crm" },
    });
    fireEvent.click(
      within(sectionFor("Negative keywords")).getByRole("button", { name: "Add" }),
    );
    await save();

    expect(puts()).toHaveLength(1);
    expect(puts()[0].path).toBe("/api/channels/google_ads/settings/negatives");
    expect(puts()[0].items).toEqual([
      { item: "free crm", item_type: "phrase", status: "tracking", origin: "custom" },
    ]);
  });

  it('keeps origin "suggested" when a suggestion is accepted, and moves only the status', async () => {
    stubApi({ keywords: REDDIT_KEYWORDS });
    mount("reddit_organic");
    await flush();
    await runSuggest();

    fireEvent.click(screen.getByRole("button", { name: "Track it" }));
    await save();

    const accepted = puts()[0].items.find((i) => i.item === "best crm");
    expect(accepted).toMatchObject({ status: "tracking", origin: "suggested" });
    expect(puts()[0].items.find((i) => i.item === "acme crm")).toMatchObject({
      status: "tracking",
    });
  });
});

describe("a save round-trips the columns it did not touch", () => {
  it("carries note, detail and origin verbatim for an untouched row", async () => {
    stubApi({ keywords: REDDIT_KEYWORDS });
    mount("reddit_organic");
    await flush();
    await runSuggest();

    fireEvent.change(screen.getByLabelText("Type for best crm"), {
      target: { value: "competitor" },
    });
    await save();

    expect(puts()).toHaveLength(1);
    const untouched = puts()[0].items.find((i) => i.item === "acme crm");
    expect(untouched).toEqual(REDDIT_KEYWORDS[0]);

    expect(puts()[0].items.find((i) => i.item === "best crm")).toEqual({
      ...REDDIT_KEYWORDS[1],
      item_type: "competitor",
    });
  });
});

describe("a refusal is shown, not swallowed", () => {
  const refusals = [
    {
      name: "400 invalid_status",
      put: {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "invalid_status",
            message: 'Status "on" is not one we store (on "free crm"). Nothing was saved.',
          },
        },
      },
    },
    {
      name: "409 field_writes_elsewhere",
      put: {
        ok: false,
        status: 409,
        body: {
          error: {
            code: "field_writes_elsewhere",
            message: "That setting has its own store and is not saved here.",
          },
        },
      },
    },
  ];

  it("falls back to the count when the refusal carries no reason", async () => {
    stubApi({}, { ok: false, status: 500, body: null });
    mount("google_ads");
    await flush();
    fireEvent.change(screen.getByLabelText("Add to Negative keywords"), { target: { value: "free crm" } });
    fireEvent.click(within(sectionFor("Negative keywords")).getByRole("button", { name: "Add" }));
    await save();
    expect(puts()).toHaveLength(1);
    expect(screen.getByText("1 of 1 didn't save. Your changes are still here. Press Save to try again.")).toBeTruthy();
    expect(within(sectionFor("Negative keywords")).getByText("free crm")).toBeTruthy();
  });

  for (const { name, put } of refusals) {
    it(`does not claim success on ${name}`, async () => {
      stubApi({}, put);
      mount("google_ads");
      await flush();

      fireEvent.change(screen.getByLabelText("Add to Negative keywords"), {
        target: { value: "free crm" },
      });
      fireEvent.click(
        within(sectionFor("Negative keywords")).getByRole("button", { name: "Add" }),
      );
      await save();

      expect(puts()).toHaveLength(1);
      expect(screen.getByText((put.body as { error: { message: string } }).error.message)).toBeTruthy();
      expect(screen.queryByText(/^Saved\./)).toBeNull();
      expect(screen.queryByText(/Saved\. Applies on the next run\./)).toBeNull();
    });
  }
});

describe("a field whose store is elsewhere is never PUT", () => {
  it("renders budget read-only and issues no PUT to it even when another field saves", async () => {
    stubApi({ budget: [{ item: "4000" }], tcpa: [{ item: "50" }] });
    mount("google_ads");
    await flush();

    const budget = screen.getByLabelText("Monthly budget") as HTMLInputElement;
    expect(budget.disabled).toBe(true);
    expect(within(sectionFor("Monthly budget")).getByText(/where pacing reads it/i)).toBeTruthy();

    const tcpa = screen.getByLabelText("Target cost per conversion") as HTMLInputElement;
    expect(tcpa.disabled).toBe(false);
    fireEvent.change(tcpa, { target: { value: "65" } });
    await save();

    expect(puts().map((p) => p.path)).toEqual([
      "/api/channels/google_ads/settings/tcpa",
    ]);
    expect(
      apiFetch.mock.calls.filter(
        ([path, init]) =>
          String(path).includes("/settings/budget") &&
          (init as RequestInit | undefined)?.method === "PUT",
      ),
    ).toEqual([]);
  });
});

describe("Suggest renders only where a producer exists", () => {
  it("offers it on reddit's keywords and competitors", async () => {
    stubApi({});
    mount("reddit_organic");
    await flush();

    expect(within(sectionFor("Keywords")).getByRole("button", { name: "Suggest" })).toBeTruthy();
    expect(within(sectionFor("Competitors")).getByRole("button", { name: "Suggest" })).toBeTruthy();
    expect(within(sectionFor("Communities")).queryByRole("button", { name: "Suggest" })).toBeNull();
  });

  it("offers none on google_ads, whose negatives declare no endpoint", async () => {
    stubApi({});
    mount("google_ads");
    await flush();

    expect(
      within(sectionFor("Negative keywords")).queryByRole("button", { name: "Suggest" }),
    ).toBeNull();
    expect(screen.queryAllByRole("button", { name: "Suggest" })).toHaveLength(0);
  });
});

describe("a GET that fails degrades to a readable dead end", () => {
  for (const how of ["404", "thrown"] as const) {
    it(`says so and renders no editable field when the GET ${how === "404" ? "404s" : "throws"}`, async () => {
      apiFetch.mockImplementation(() =>
        how === "404"
          ? respond(false, 404, { error: { code: "unknown_channel" } })
          : Promise.reject(new TypeError("Failed to fetch")),
      );
      mount("google_ads");
      await flush();

      expect(screen.getByText(/available yet/i)).toBeTruthy();
      expect(screen.queryByText(/Reading your settings/)).toBeNull();
      expect(screen.queryAllByRole("textbox")).toHaveLength(0);
      expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    });
  }
});
