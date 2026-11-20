import { describe, it, expect } from "vitest";
import {
  runAcceptanceBattery,
  STARTER_APP_DESCRIPTION,
  STARTER_APP_TITLE,
  type FetchLike,
  type Invariant,
} from "../acceptance-gate";
import { TEMPLATE_FILES } from "../templates/nextjs-supabase-tailwind/template-files.generated";

const BASE = "https://acme.test";

function homeFetch(home: string): FetchLike {
  return async (url) => {
    const path = new URL(url).pathname;
    const body = path === "/" ? home : "";
    return {
      status: path === "/" ? 200 : 404,
      headers: { get: () => null },
      text: async () => body,
    };
  };
}

function page(title: string, description: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><title>${title}</title><meta name="description" content="${description}"/></head><body><main><h1>Fresh cuts</h1></main></body></html>`;
}

const details = (res: { invariants: Invariant[] }) => res.invariants.find((i) => i.name === "STARTER_DETAILS");

describe("old-flow live check: a site that kept the starter description", () => {
  it("fails STARTER_DETAILS as a smoke invariant, so the smoke-only gate enforces it and the repair says what to fix", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, starterDetailsCheck: true },
      homeFetch(page("Fresh Cuts Barbers", STARTER_APP_DESCRIPTION)),
    );
    const inv = details(res)!;
    expect(inv.pass).toBe(false);
    expect(inv.smoke).toBe(true);
    expect(inv.evidence).toContain("the starter description");
    expect(inv.evidence).toContain("app/layout.tsx");
    expect(res.pass).toBe(false);
    expect(res.invariants.find((i) => i.name === "REAL_APP")!.pass).toBe(true);
  });

  it("also names a kept starter title", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, starterDetailsCheck: true },
      homeFetch(page(STARTER_APP_TITLE, STARTER_APP_DESCRIPTION)),
    );
    expect(details(res)!.evidence).toContain(`the starter title "${STARTER_APP_TITLE}" and the starter description`);
  });

  it("passes a site with its own title and description", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, starterDetailsCheck: true },
      homeFetch(page("Fresh Cuts Barbers", "Walk-in and booked haircuts in Leeds.")),
    );
    expect(details(res)!.pass).toBe(true);
  });

  it("is not run when site_meta_and_404 is off", async () => {
    const res = await runAcceptanceBattery({ baseUrl: BASE }, homeFetch(page("Fresh Cuts Barbers", STARTER_APP_DESCRIPTION)));
    expect(details(res)).toBeUndefined();
  });

  it("a home page that does not answer is not blamed on the page details", async () => {
    const down: FetchLike = async () => ({ status: 503, headers: { get: () => null }, text: async () => "" });
    const res = await runAcceptanceBattery({ baseUrl: BASE, starterDetailsCheck: true }, down);
    expect(details(res)!.pass).toBe(true);
  });

  it("the description it rejects is the one the Next starter layout ships", () => {
    expect(TEMPLATE_FILES["app/layout.tsx"]).toContain(`description: "${STARTER_APP_DESCRIPTION}"`);
  });
});
