
import { describe, it, expect } from "vitest";
import { customDomainDnsRecords, RENDER_APEX_IP } from "../render-custom-domain";

const URL_ = "https://myapp-abc.onrender.com";

describe("customDomainDnsRecords", () => {
  it("subdomain → a single CNAME to the onrender host", () => {
    expect(customDomainDnsRecords("app.acme.com", URL_, "subdomain")).toEqual([
      { type: "CNAME", host: "app.acme.com", value: "myapp-abc.onrender.com" },
    ]);
  });

  it("defaults to the subdomain CNAME when no type is passed (back-compat)", () => {
    expect(customDomainDnsRecords("app.acme.com", URL_)[0].type).toBe("CNAME");
  });

  it("apex → an A record to Render's edge IP, never a CNAME", () => {
    const recs = customDomainDnsRecords("acme.com", URL_, "apex");
    expect(recs.some((r) => r.type === "CNAME")).toBe(false);
    expect(recs[0]).toMatchObject({ type: "A", host: "@", value: RENDER_APEX_IP });
    expect(recs[0].note).toBeTruthy();
  });

  it("apex → also offers ALIAS/ANAME to the onrender host as the alternative", () => {
    const alias = customDomainDnsRecords("acme.com", URL_, "apex").find((r) => r.type === "ALIAS");
    expect(alias).toMatchObject({ host: "@", value: "myapp-abc.onrender.com" });
  });

  it("apex with an unknown onrender host → A record only (no empty-valued ALIAS)", () => {
    expect(customDomainDnsRecords("acme.com", null, "apex")).toEqual([
      expect.objectContaining({ type: "A", value: RENDER_APEX_IP }),
    ]);
  });
});
