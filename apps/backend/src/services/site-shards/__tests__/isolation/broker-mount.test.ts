import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(join(__dirname, "../../../../app.ts"), "utf8").replace(/\s+/g, " ");
const edge = readFileSync(join(__dirname, "edge.ts"), "utf8").replace(/\s+/g, " ");

describe("isolation gate mirrors app.ts's broker mounts", () => {
  it.each([
    ['app.post( "/api/public/site-auth/hooks/send-email/:shardId", express.raw({ type: () => true, limit: "64kb" }), siteAuthSendEmailHook, );',
      'app.post("/api/public/site-auth/hooks/send-email/:shardId", express.raw({ type: () => true, limit: "64kb" }),'],
    ['app.post("/api/public/site-auth/:op", express.raw({ type: () => true, limit: "16kb" }), siteAuthRoute);',
      'app.post("/api/public/site-auth/:op", express.raw({ type: () => true, limit: "16kb" }),'],
    ['app.get("/api/public/site-auth/:op", siteAuthRoute);', 'app.get("/api/public/site-auth/:op",'],
  ])("%s", (prod, harness) => {
    expect(app).toContain(prod);
    expect(edge).toContain(harness);
  });

  it("both trust exactly one proxy hop", () => {
    expect(app).toContain('app.set("trust proxy", 1);');
    expect(edge).toContain('app.set("trust proxy", 1);');
  });
});
