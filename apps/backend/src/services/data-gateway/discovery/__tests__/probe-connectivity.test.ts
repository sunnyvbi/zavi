import { describe, it, expect, vi, beforeEach } from "vitest";

const listCollections = vi.fn(() => ({ toArray: async () => [{ name: "users" }, { name: "trips" }] }));
const aggregate = vi.fn(() => ({ toArray: async () => [] }));
const collection = vi.fn(() => ({ aggregate }));

vi.mock("mongodb", () => ({
  MongoClient: class {
    constructor(_uri: string, _opts?: unknown) {}
    async connect() { return this; }
    db() { return { listCollections, collection }; }
    async close() { return undefined; }
  },
}));
vi.mock("mongodb-schema", () => ({ parseSchema: async () => ({ fields: [] }) }));

import { probeConnectivity } from "../run";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("probeConnectivity", () => {
  it("connects + lists WITHOUT sampling any collection → ok:true", async () => {
    const r = await probeConnectivity("mongodb", "mongodb+srv://u:p@c.mongodb.net/upcar");
    expect(r).toEqual({ ok: true });
    expect(listCollections).toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
  });

  it("bad connection string (no db name) → ok:false with sanitized error, no throw", async () => {
    const r = await probeConnectivity("mongodb", "mongodb+srv://u:p@c.mongodb.net/?x=1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/database name/i);
    expect(aggregate).not.toHaveBeenCalled();
  });
});
