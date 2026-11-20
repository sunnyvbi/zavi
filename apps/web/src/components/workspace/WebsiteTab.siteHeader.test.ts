// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { paneAppName } from "./WebsiteTab";

const site = {
  hostname: "paws-suds-693dfbdb-aaaaaa.zaviagent.com",
  live_url: null,
  status: "building",
  name: "Paws & Suds",
  repo: "Praxis-build/paws-suds-693dfbdb-aaaaaa",
};

describe("DEL-1323 B24: the Build header is named after the open site, not the workspace", () => {
  it("while the site builds in its sandbox (preview host carries no name) the header is the site's name", () => {
    expect(paneAppName({ siteNames: true, site, appHost: "5173-abc.e2b.app", tenantName: "Apna Tutor" })).toBe("Paws & Suds");
  });

  it("with no stored name the header comes from the site's own hostname, without the hash and id", () => {
    expect(paneAppName({ siteNames: true, site: { ...site, name: null }, appHost: "5173-abc.e2b.app", tenantName: "Apna Tutor" })).toBe(
      "Paws Suds",
    );
    expect(paneAppName({ siteNames: false, site, appHost: "paws-suds-693dfbdb-aaaaaa.zaviagent.com", tenantName: "Apna Tutor" })).toBe(
      "Paws Suds",
    );
  });

  it("never names a site session after the workspace's singleton host", () => {
    expect(paneAppName({ siteNames: true, site, appHost: "apna-tutor-693dfbdb.zaviagent.com", tenantName: "Apna Tutor" })).toBe(
      "Paws & Suds",
    );
  });

  it("an old-flow build (no site) keeps the host, then workspace, naming as before", () => {
    expect(paneAppName({ siteNames: true, site: null, appHost: "apna-tutor-693dfbdb.zaviagent.com", tenantName: "Apna Tutor" })).toBe(
      "Apna Tutor",
    );
    expect(paneAppName({ siteNames: true, site: null, appHost: "hush.zaviagent.com", tenantName: "Apna Tutor" })).toBe("Hush");
    expect(paneAppName({ siteNames: true, site: null, appHost: null, tenantName: "Apna Tutor" })).toBe("Apna Tutor");
  });
});
