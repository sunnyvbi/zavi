import { describe, expect, it } from "vitest";
import { appDisplayName } from "./appDisplayName";

describe("appDisplayName", () => {
  it("names the app after the deploy host, not the workspace", () => {
    expect(appDisplayName("hush.zaviagent.com", "Zavi")).toBe("Hush");
  });

  it("does not name a www-prefixed registered site 'Www'", () => {
    expect(appDisplayName("www.acme.dev", "Zavi")).toBe("Acme");
    expect(appDisplayName("WWW.ACME.DEV", null)).toBe("Acme");
    expect(appDisplayName("www.www.acme.dev", null)).toBe("Acme");
  });

  it("reads a host even when handed a whole URL", () => {
    expect(appDisplayName("https://www.acme.dev/pricing?x=1#top", null)).toBe("Acme");
    expect(appDisplayName("https://user@hush.zaviagent.com:8443/", null)).toBe("Hush");
  });

  it("spaces a slug host instead of shouting it back", () => {
    expect(appDisplayName("my-shop.zaviagent.com", null)).toBe("My Shop");
    expect(appDisplayName("green_tea_co.onrender.com", null)).toBe("Green Tea Co");
  });

  it("falls back to the tenant when the host carries no name", () => {
    expect(appDisplayName("localhost:3010", "Upcar")).toBe("Upcar");
    expect(appDisplayName("127.0.0.1:3000", "Upcar")).toBe("Upcar");
    expect(appDisplayName("", "  upcar  ")).toBe("Upcar");
    expect(appDisplayName(null, "Acme Corp")).toBe("Acme Corp");
  });

  it("never names the app after the build sandbox's preview host", () => {
    expect(appDisplayName("3000-if8mje0yhqsdybsh85246.e2b.app", "Laptop Rentals")).toBe("Laptop Rentals");
    expect(appDisplayName("https://3001-if8mje0yhqsdybsh85246.e2b.app/", "Laptop Rentals")).toBe("Laptop Rentals");
    expect(appDisplayName("5173-abc123.E2B.DEV", "Acme Corp")).toBe("Acme Corp");
    expect(appDisplayName("3000-if8mje0yhqsdybsh85246.e2b.app", null)).toBeNull();
  });

  it("drops the workspace hash Zavi appends to a built site's host", () => {
    expect(appDisplayName("apna-tutor-693dfbdb.zaviagent.com", "Apna Tutor")).toBe("Apna Tutor");
    expect(appDisplayName("https://paws-and-suds-693dfbdb.zaviagent.com/admin", null)).toBe("Paws And Suds");
    expect(appDisplayName("apna-tutor-693dfbdb.onrender.com", null)).toBe("Apna Tutor");
    expect(appDisplayName("hush-0a1b2c3d.zaviagent.com", "Zavi")).toBe("Hush");
  });

  it("DEL-1323 B24: drops the tenant hash AND the site id of a new-flow site's host", () => {
    expect(appDisplayName("dog-grooming-salon-693dfbdb-a1b2c3.zaviagent.com", "Apna Tutor")).toBe("Dog Grooming Salon");
    expect(appDisplayName("https://paws-suds-693dfbdb-0f9e8d.zaviagent.com/admin", "Apna Tutor")).toBe("Paws Suds");
    expect(appDisplayName("paws-suds-693dfbdb-0f9e8d-dev.zaviagent.com", "Apna Tutor")).toBe("Paws Suds");
    expect(appDisplayName("still-water-yoga-1a2b3c4d-abcdef.zaviagent.com", null)).toBe("Still Water Yoga");
  });

  it("drops the workspace hash AND site id of a new-flow site's host (QA B24)", () => {
    expect(appDisplayName("mile-high-coffee-693dfbdb-523441.zaviagent.com", "Apna Tutor")).toBe("Mile High Coffee");
    expect(appDisplayName("https://lucky-paws-grooming-693dfbdb-687f66.zaviagent.com/", null)).toBe("Lucky Paws Grooming");
    expect(appDisplayName("mile-high-coffee-693dfbdb-523441-dev.zaviagent.com", null)).toBe("Mile High Coffee");
    expect(appDisplayName("apna-tutor-693dfbdb-dev.zaviagent.com", null)).toBe("Apna Tutor");
    expect(appDisplayName("mile-high-coffee-693dfbdb-523441.zaviagent.com")).toBe("Mile High Coffee");
    expect(appDisplayName("cafe-deadbeef-693dfbdb-523441.zaviagent.com")).toBe("Cafe Deadbeef");
    expect(appDisplayName("cafe-deadbeef-693dfbdb.zaviagent.com")).toBe("Cafe Deadbeef");
    expect(appDisplayName("shop-693dfbdb-523441-west.zaviagent.com")).toBe("Shop 693dfbdb 523441 West");
    expect(appDisplayName("3000-abc.e2b.app", null)).toBeNull();
    expect(appDisplayName(null, null)).toBeNull();
  });

  it("keeps a real name that only looks like a hash suffix", () => {
    expect(appDisplayName("cafe-deadbeef.com", null)).toBe("Cafe Deadbeef");
    expect(appDisplayName("deadbeef.zaviagent.com", null)).toBe("Deadbeef");
    expect(appDisplayName("shop-2026.zaviagent.com", null)).toBe("Shop 2026");
    expect(appDisplayName("shop-ab12cd34ef.zaviagent.com", null)).toBe("Shop Ab12cd34ef");
  });

  it("has nothing to show when neither is set", () => {
    expect(appDisplayName(null, null)).toBeNull();
    expect(appDisplayName(undefined, undefined)).toBeNull();
    expect(appDisplayName("localhost", "   ")).toBeNull();
  });
});
