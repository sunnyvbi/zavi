import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  looksLikeSeedPlaceholder,
  SEED_PLACEHOLDER_MARKERS,
} from "../seed-markers";

describe("looksLikeSeedPlaceholder — FALSE-LIVE placeholder detection", () => {
  it("matches the seed scaffold's served HTML (title marker)", () => {
    expect(
      looksLikeSeedPlaceholder(
        "<html><head><title>Your Company</title></head><body></body></html>",
      ),
    ).toBe(true);
  });

  it("matches the seed landing-page copy", () => {
    expect(
      looksLikeSeedPlaceholder("<h1>Your company app is live.</h1>"),
    ).toBe(true);
    expect(
      looksLikeSeedPlaceholder("<p>This is a working Next.js starter.</p>"),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(looksLikeSeedPlaceholder("<TITLE>YOUR COMPANY</TITLE>")).toBe(true);
  });

  it("does NOT match a real generated app", () => {
    const real =
      "<html><head><title>LocalPro — find a pro</title></head><body><h1>Book trusted local service providers</h1><nav>Listings · Providers · Bookings</nav></body></html>";
    expect(looksLikeSeedPlaceholder(real)).toBe(false);
  });

  it("a real page that kept the seed <main data-zavi-seed> wrapper is not the placeholder; the untouched seed page still is (DEL-1323 B2)", () => {
    const real =
      '<html><head><title>Still Water Yoga</title></head><body><main data-zavi-seed="placeholder" class="flex"><h1>Book your next class</h1><form><input name="date"/><button>Book</button></form></main></body></html>';
    expect(looksLikeSeedPlaceholder(real)).toBe(false);
    const seed =
      '<html><head><title>Still Water Yoga</title></head><body><main data-zavi-seed="placeholder" class="flex"><h1>Coming soon</h1><p>This site is being built. Check back shortly.</p></main></body></html>';
    expect(looksLikeSeedPlaceholder(seed)).toBe(true);
    expect(looksLikeSeedPlaceholder('<main data-zavi-seed="placeholder"><h1>Coming soon: the spring timetable</h1></main>')).toBe(false);
  });

  it("is conservative on empty / non-string bodies (returns false)", () => {
    expect(looksLikeSeedPlaceholder("")).toBe(false);
    expect(looksLikeSeedPlaceholder(null)).toBe(false);
    expect(looksLikeSeedPlaceholder(undefined)).toBe(false);
    expect(looksLikeSeedPlaceholder(123)).toBe(false);
  });

  it("markers are present verbatim in the seed template files", () => {
    const tpl = readFileSync(
      join(
        __dirname,
        "../templates/nextjs-supabase-tailwind/template-files.generated.ts",
      ),
      "utf-8",
    );
    expect(tpl).toContain("Your Company");
    expect(tpl).toContain("Your company app is live.");
    expect(tpl).toContain("This is a working Next.js starter.");
  });

  it("exposes the markers list for the build-status.mjs diagnostic to mirror", () => {
    expect(SEED_PLACEHOLDER_MARKERS.length).toBeGreaterThanOrEqual(3);
    expect(SEED_PLACEHOLDER_MARKERS).toContain("<title>Your Company</title>");
  });
});
