
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { START_CARD_DONE_FIXTURE, type StartCard } from "@zavi/shared";

const H = vi.hoisted(() => ({ card: null as unknown, throws: false }));

vi.mock("@/components/marketing/growth-home/GrowthHeader", () => ({ GrowthHeader: () => null }));
vi.mock("@/components/marketing/growth-home/GrowthFooter", () => ({ GrowthFooter: () => null }));
vi.mock("@/lib/start-card/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/start-card/api")>();
  return {
    ...real,
    getStartCard: vi.fn(async () => {
      if (H.throws) throw new Error("backend down");
      return H.card;
    }),
  };
});

vi.mock("./RefreshWhileRunning", () => ({ RefreshWhileRunning: () => "REFRESHING" }));

import ResultPage, { generateMetadata } from "./page";

const ID = START_CARD_DONE_FIXTURE.public_id;
const hidden = (status: "removed" | "expired"): StartCard => ({
  ...START_CARD_DONE_FIXTURE,
  status,
  parts: {},
  score: null,
  search_term: null,
});

async function html(): Promise<string> {
  return renderToStaticMarkup(await ResultPage({ params: Promise.resolve({ id: ID }) }));
}

beforeEach(() => {
  H.card = START_CARD_DONE_FIXTURE;
  H.throws = false;
});

describe("/r/[id]", () => {
  it("renders the read-only card and the challenge CTA", async () => {
    const out = await html();
    expect(out).toContain("Your growth score: 63/100");
    expect(out).toContain("Scan my site (free, sign in with Google)");
    expect(out).toContain(`href="/start?ref=${ID}"`);
    expect(out).not.toContain("This is my business");
  });

  it("a card still being scored refreshes itself; a finished one does not", async () => {
    expect(await html()).not.toContain("REFRESHING");
    H.card = { ...START_CARD_DONE_FIXTURE, status: "running", score: null };
    expect(await html()).toContain("REFRESHING");
  });

  it("is noindex, with the score in the title", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ id: ID }) });
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(String(meta.title)).toContain("scored 63/100");
  });

  it("removed: says so, draws no card", async () => {
    H.card = hidden("removed");
    const out = await html();
    expect(out).toContain("Removed at the owner&#x27;s request");
    expect(out).not.toContain("growth-card");
  });

  it("expired: asks to scan again, draws no card", async () => {
    H.card = hidden("expired");
    const out = await html();
    expect(out).toContain("This result expired, scan again");
    expect(out).not.toContain("growth-card");
  });

  it("unknown id and a backend error each get their own message", async () => {
    H.card = null;
    expect(await html()).toContain("This result doesn&#x27;t exist");
    H.throws = true;
    expect(await html()).toContain("We couldn&#x27;t load this result");
  });
});
