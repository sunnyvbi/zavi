import { describe, it, expect } from "vitest";
import { matchRoute } from "../../../../../../../../../infra/site-gateway/src/worker";
import { gatewayRoutes, createLocalServer } from "../../files/src/zavi/local";
import { DevStore } from "../../files/src/zavi/devstore";
import { validateManifest } from "../../manifest";
import { TEMPLATE_FILES } from "../../template-files.generated";

const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const GATEWAY_CASES: Array<[string, string]> = [
  ["GET", "/api/site"], ["POST", "/api/site"], ["GET", "/api/site/x"],
  ["GET", "/api/data/messages"], ["POST", "/api/data/messages"], ["PUT", "/api/data/messages"],
  ["GET", "/api/data/Messages"], ["GET", "/api/data/9bad"], ["GET", "/api/data/a-b"], ["GET", "/api/data/"],
  ["GET", `/api/data/messages/${ID}`], ["GET", `/api/data/messages/${ID.toUpperCase()}`], ["PATCH", `/api/data/messages/${ID}`],
  ["DELETE", `/api/data/messages/${ID}`], ["POST", `/api/data/messages/${ID}`], ["GET", "/api/data/messages/not-a-uuid"],
  ["GET", "/api/storage/photos/list"], ["GET", "/api/storage/Bad-Area/list"], ["GET", "/api/storage/../list"],
  ["GET", "/api/storage/9photos/list"], ["POST", "/api/storage/photos/list"], ["POST", "/api/storage/photos/upload-url"],
  ["POST", "/api/storage/photos/download-url"], ["GET", "/api/storage/photos/download-url"], ["DELETE", "/api/storage/photos/a.png"],
  ["DELETE", "/api/storage/photos/.hidden"], ["DELETE", "/api/storage/photos/a%2Fb"], ["GET", "/api/storage/photos/object/a.png"],
  ["PUT", "/api/storage/photos/object/a.png"], ["GET", "/api/storage/photos/object/..png"], ["GET", "/api/storage/photos"],
  ["POST", "/api/auth/signup"], ["GET", "/api/auth/signup"], ["GET", "/api/auth/callback"], ["POST", "/api/auth/callback"],
  ["POST", "/api/auth/admin"], ["POST", "/api/auth/login/x"], ["GET", "/api/nope"], ["GET", "/api"], ["GET", "/api//data"],
];

describe("dev router == gateway router", () => {
  it.each(GATEWAY_CASES)("%s %s", (method, path) => {
    expect(gatewayRoutes(method, path)).toBe(matchRoute(method, path) !== null);
  });

  it("contract kernel routes are served; their malformed twins are not", () => {
    const yes: Array<[string, string]> = [
      ["POST", "/api/actions/reserve_slot"], ["POST", "/api/aggregates/booking_count"], ["POST", `/api/data/listings/${ID}/transition`],
      ["POST", "/api/members/invite"], ["GET", "/api/members/list"], ["POST", "/api/members/set-role"], ["POST", "/api/members/disable"], ["POST", "/api/members/remove"], ["POST", "/api/members/reenable"],
      ["POST", "/api/members/reassign-owner"], ["POST", "/api/members/delete-data"],
    ];
    const no: Array<[string, string]> = [
      ["GET", "/api/actions/reserve_slot"], ["POST", "/api/actions/Reserve"], ["POST", "/api/actions/a/b"], ["POST", "/api/aggregates/x-y"],
      ["POST", "/api/data/listings/nope/transition"], ["PATCH", `/api/data/listings/${ID}/transition`], ["POST", "/api/members/list"],
      ["GET", "/api/members/invite"], ["POST", "/api/members/delete"],
    ];
    for (const [m, p] of yes) expect(gatewayRoutes(m, p), `${m} ${p}`).toBe(true);
    for (const [m, p] of no) expect(gatewayRoutes(m, p), `${m} ${p}`).toBe(false);
  });

  it("an invalid storage area is 404 no_such_route in dev mode, as at the gateway (not 200 [])", async () => {
    const m = validateManifest(TEMPLATE_FILES["zavi-site.json"]);
    if (!m.ok) throw new Error("starter manifest");
    const server = createLocalServer({ store: new DevStore({ manifest: m.value }), siteId: "00000000-0000-4000-8000-00000000d0e0" });
    for (const path of ["/api/storage/Bad-Area/list", "/api/storage/../list", "/api/data/Bad-Name", "/api/actions/x/y"]) {
      const res = await server.fetch(path, { method: "GET", headers: {} });
      expect(res.status, path).toBe(404);
      expect(JSON.parse(await res.text()).error.code, path).toBe("no_such_route");
    }
    const site = await server.fetch("/api/site", { method: "GET", headers: {} });
    expect(JSON.parse(await site.text()).data).toEqual({ site_id: "00000000-0000-4000-8000-00000000d0e0", turnstile_site_key: null });
  });
});
