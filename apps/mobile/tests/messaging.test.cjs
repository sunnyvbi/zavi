const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const m = loadTs(path.join(__dirname, "../src/features/connectors/messaging.ts"));
const wc = loadTs(path.join(__dirname, "../src/features/connectors/webCatalog.ts"));

const NOW = Date.parse("2026-10-07T12:00:00Z");
const plain = (v) => JSON.parse(JSON.stringify(v));

function build(rows) {
  return m.messagingConnections({
    rows,
    labelFor: (s) => wc.WEB_LABELS[s] ?? s,
    usedByFor: () => [],
    now: NOW,
  });
}

test("all five chat apps, in web's order, none connected", () => {
  const list = build([]);
  assert.deepEqual(
    plain(list.map((c) => c.slug)),
    ["slack", "whatsapp", "telegram", "discord", "teams"],
  );
  assert.ok(list.every((c) => c.health === "off"));
  assert.equal(list[4].label, "Microsoft Teams");
  assert.equal(list[4].purpose, "Message your agents from Microsoft Teams.");
});

test("connected rows keep web's order and other connectors are dropped", () => {
  const list = build([
    { slug: "github", account_login: "acme", repo_full_names: ["acme/app"] },
    { slug: "teams", connected_at: "2026-10-01T00:00:00Z" },
    { slug: "stripe", team_name: "Acme" },
    { slug: "discord", team_name: "Acme server" },
  ]);
  assert.deepEqual(
    plain(list.map((c) => [c.slug, c.health])),
    [
      ["slack", "off"],
      ["whatsapp", "off"],
      ["telegram", "off"],
      ["discord", "connected"],
      ["teams", "connected"],
    ],
  );
  assert.equal(list[3].detail, "Acme server");
});

test("Integrations lists Teams only once it is connected, as web has no Teams tile there", () => {
  const h = loadTs(path.join(__dirname, "../src/features/connectors/health.ts"));
  const integrations = (rows) =>
    h.buildConnections({
      rows,
      suggested: wc.NATIVE_SLUGS,
      labelFor: (s) => wc.WEB_LABELS[s] ?? s,
      usedByFor: () => [],
      now: NOW,
    });
  assert.equal(integrations([]).find((c) => c.slug === "teams"), undefined);
  const teams = integrations([{ slug: "teams" }]).find((c) => c.slug === "teams");
  assert.equal(teams.health, "connected");
  assert.equal(teams.label, "Microsoft Teams");
  assert.equal(h.rowSubtitle(teams, NOW), "Message your agents from Microsoft Teams.");
});

test("Teams bind errors use web's copy, and anything else reads as bind_failed", () => {
  const cases = {
    m365_already_bound:
      "That Teams org is already connected to a different Zavi workspace. Disconnect it there first.",
    invalid_or_expired: "That code is invalid or expired. Re-add the Zavi app in Teams to get a fresh code.",
    not_admin: "Only a workspace owner or admin can connect Microsoft Teams.",
    missing_bind_code: "Enter the code Zavi sent you in Teams.",
    teams_disabled: "Microsoft Teams isn't enabled yet.",
    bind_failed: "Couldn't connect right now. Try again in a moment.",
  };
  for (const [code, text] of Object.entries(cases)) assert.equal(m.teamsBindError(code), text);
  assert.equal(m.teamsBindError("http_500"), cases.bind_failed);
  assert.equal(m.teamsBindError(undefined), cases.bind_failed);
  assert.equal(m.teamsBindError(""), cases.bind_failed);
});
