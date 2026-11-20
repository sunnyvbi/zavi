const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const name = loadTs(path.join(__dirname, "../src/features/onboarding/companyName.ts"));

test("a social profile or store listing gives no company name", () => {
  for (const host of ["facebook.com", "m.facebook.com", "instagram.com", "linktr.ee", "amazon.co.uk", "apps.apple.com"]) {
    assert.equal(name.companyNameFromHost(host), "", host);
  }
});

test("the founder's own domain still gives a guess", () => {
  assert.equal(name.companyNameFromHost("greenfarm.com"), "Greenfarm");
  assert.equal(name.companyNameFromHost("team.upcar.ai"), "Team");
  assert.equal(name.companyNameFromHost("notfacebook.com"), "Notfacebook");
  assert.equal(name.isPlatformHost("amazonia-coffee.com"), false);
});
