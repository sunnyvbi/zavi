import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRunnerConfig, synthesizeRecord, pickWriteCollection, ManifestError } from "../config";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/vite-react-supabase/template-files.generated";

const TAG = "zavi-smoke-0123456789abcdef";
const build = (m: unknown, allow_writes = true, backend_mode: string | null = null) =>
  buildRunnerConfig({ manifestRaw: typeof m === "string" ? m : JSON.stringify(m), allow_writes, backend_mode, tag: TAG });

describe("customer journeys", () => {
  const j = (journeys: unknown[]) => ({ smoke: { journeys } });
  const book = { name: "book", path: "/book", as: "customer", writes: true, steps: [{ fill: "[data-zavi=book-name]", value: "{smoke}" }, { click: "[data-zavi=book-submit]" }] };

  it("accepts a customer journey, which may need an owner journey before it (an owner opens times first)", () => {
    const c = build(j([{ name: "open-times", path: "/admin", as: "owner" }, { ...book, needs: "open-times" }]));
    expect(c.journeys.find((x) => x.name === "book")).toMatchObject({ as: "customer", needs: "open-times" });
  });

  it("a visitor journey can never need a signed-in one (visitors run first)", () => {
    expect(() => build(j([book, { name: "after", path: "/", needs: "book" }]))).toThrow(ManifestError);
  });

  it("deniedRead stays a visitor step", () => {
    expect(() => build(j([{ name: "c", path: "/", as: "customer", steps: [{ deniedRead: "bookings" }] }]))).toThrow(/visitor journey/);
  });

  it("an unknown role is refused", () => {
    expect(() => build(j([{ name: "c", path: "/", as: "staff" }]))).toThrow(/"visitor", "customer" or "owner"/);
  });
});

describe("buildRunnerConfig", () => {
  it("the vite-react-supabase starter manifest is a dedicated site with its routes", () => {
    const c = build(TEMPLATE_FILES["zavi-site.json"]);
    expect(c).toMatchObject({ starter: "dedicated", write: null, protected_lists: [], routes: ["/", "/login"], allow_writes: true, tag: TAG });
    expect(c.journeys.map((j) => j.name)).toEqual(["home", "login"]);
  });

  it("the vite-react-zavi (pooled) starter manifest gets the pooled write journey", () => {
    const c = build(readFileSync(join(__dirname, "pooled-starter-manifest.fixture.json"), "utf-8"));
    expect(c.starter).toBe("pooled");
    expect(c.routes).toEqual(["/", "/login", "/admin"]);
    expect(c.write).toEqual({
      collection: "messages",
      record: { name: "{smoke}", body: "zavi smoke" },
      tag_field: "name",
      protected_get: true,
      protected_list: true,
    });
    expect(c.protected_lists).toEqual(["messages"]);
    expect(c.journeys.find((j) => j.name === "admin-sees-message")).toMatchObject({ as: "owner", needs: "contact-create" });
    expect(build(readFileSync(join(__dirname, "pooled-starter-manifest.fixture.json"), "utf-8"), false).write).toBeNull();
  });

  it("backend_mode pooled forces the pooled starter", () => {
    expect(build({ smoke: { journeys: [{ name: "home", path: "/" }] } }, true, "pooled").starter).toBe("pooled");
  });

  it("adds visit steps and a manifest routes list, and caps routes", () => {
    const c = build({ routes: ["/pricing"], smoke: { journeys: [{ name: "a", path: "/a", steps: [{ visit: "/b?x=1" }] }] } });
    expect(c.routes).toEqual(["/", "/a", "/b?x=1", "/pricing"]);
    const many = Array.from({ length: 25 }, (_, i) => `/p${i}`);
    expect(() => build({ routes: many, smoke: { journeys: [{ name: "a", path: "/" }] } })).toThrow(/more than 20 distinct routes/);
  });

  it.each([
    ["not JSON", "{", /not valid JSON/],
    ["no journeys", { smoke: { journeys: [] } }, /non-empty array/],
    ["bad name", { smoke: { journeys: [{ name: "zavi:home", path: "/" }] } }, /lowercase-kebab/],
    ["off-site path", { smoke: { journeys: [{ name: "a", path: "https://evil.example" }] } }, /same-site path/],
    ["protocol-relative", { smoke: { journeys: [{ name: "a", path: "//evil.example" }] } }, /same-site path/],
    ["css selector", { smoke: { journeys: [{ name: "a", path: "/", expect: "body" }] } }, /data-zavi hook/],
    ["unknown step", { smoke: { journeys: [{ name: "a", path: "/", steps: [{ eval: "1" }] }] } }, /unknown step/],
    ["writes without tag", { smoke: { journeys: [{ name: "a", path: "/", writes: true, steps: [{ fill: "[data-zavi=x]", value: "hi" }] }] } }, /\{smoke\}/],
    ["deniedRead without a writes dep", { smoke: { journeys: [{ name: "a", path: "/", steps: [{ deniedRead: "messages" }] }] } }, /needs/],
    ["owner deniedRead", { smoke: { journeys: [{ name: "a", path: "/", as: "owner", steps: [{ deniedRead: "m" }] }] } }, /visitor journey/],
  ])("rejects %s", (_l, m, re) => {
    expect(() => build(m)).toThrow(ManifestError);
    expect(() => build(m)).toThrow(re);
  });
});

describe("pooled write record", () => {
  it("meets enum, email, length and number constraints", () => {
    const r = synthesizeRecord({
      schema: {
        type: "object",
        required: ["kind", "email", "at", "code", "qty", "title"],
        properties: {
          kind: { type: "string", enum: ["a", "b"] },
          email: { type: "string", format: "email" },
          at: { type: "string", format: "date-time" },
          code: { type: "string", minLength: 2, maxLength: 4 },
          qty: { type: "integer", minimum: 1 },
          title: { type: "string", maxLength: 60 },
        },
      },
    });
    expect(r).toEqual({
      record: { kind: "a", email: "smoke@example.com", at: "2030-01-01T12:00:00Z", code: "zavi", qty: 1, title: "{smoke}" },
      tag_field: "title",
    });
  });

  it("refuses a required field only an admin may write, or an unknown type", () => {
    expect(synthesizeRecord({ schema: { required: ["s"], properties: { s: { type: "string" } } }, fields: { s: { write: ["admin"] } } })).toEqual({
      error: 'required field "s" is not writable by a visitor',
    });
    expect(synthesizeRecord({ schema: { required: ["o"], properties: { o: { type: "object" } } } })).toMatchObject({ error: expect.stringMatching(/"o"/) });
  });

  it("fails closed when visitor-creatable collections exist but none can be filled", () => {
    const doc = { collections: { bookings: { rules: { create: ["anyone"] }, schema: { required: ["code"], properties: { code: { type: "string", pattern: "^[A-Z]{3}$" } } } } } };
    expect(() => pickWriteCollection(doc)).toThrow(/cannot create a test record in collections\.bookings: required field "code"/);
  });

  it("only picks a visitor-creatable collection, preferring protected reads", () => {
    const doc = {
      collections: {
        closed: { rules: { create: ["admin"] }, schema: { type: "object", properties: {} } },
        open: { rules: { create: ["anyone"], get: ["anyone"], list: ["anyone"] }, schema: { type: "object", properties: {} } },
        guarded: { rules: { create: ["anyone"], get: ["admin"], list: ["anyone"] }, schema: { type: "object", properties: {} } },
      },
    };
    expect(pickWriteCollection(doc)).toMatchObject({ collection: "guarded", protected_get: true, protected_list: false });
    expect(pickWriteCollection({ collections: { closed: doc.collections.closed } })).toBeNull();
  });
});
