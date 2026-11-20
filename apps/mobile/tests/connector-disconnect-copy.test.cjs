const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const catalog = loadTs(path.join(__dirname, "../src/features/connectors/catalog.ts"), {
  "@zavi/shared": { CHANNELS: [], connectInfoFor: () => null, railFor: () => null },
});
const web = loadTs(path.join(__dirname, "../../web/src/components/workspace/settings/connectorDisconnect.ts"), {
  "@/lib/api": { apiFetch: () => { throw new Error("no network in tests"); } },
  "@/components/ui/ConfirmDialog": { confirmAction: () => false },
  "./connectorErrorDialog": { showConnectorError: () => {} },
  "@/lib/workspace/channelReadCache": { clearChannelReadCache: () => {} },
});

test("the mobile LinkedIn Ads disconnect dialog warns that live campaigns keep running and spending, word for word as web", () => {
  const mobile = catalog.disconnectCopy("linkedin_ads");
  const webSpec = web.CONNECTOR_DISCONNECT.linkedin_ads;
  assert.equal(mobile.title, webSpec.title);
  assert.equal(mobile.description, webSpec.description);
  assert.match(mobile.description, /keep running and spending/);
  assert.match(mobile.description, /pause them in LinkedIn Campaign Manager first/);
});
