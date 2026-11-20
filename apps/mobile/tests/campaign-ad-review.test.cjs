const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");
const shared = loadTs(path.join(__dirname, "../../../packages/shared/src/channels/ad-review.ts"), {
  zod: require("zod"), "./ad-approval": { AD_IMAGE_PATH_RE: /^tenants\/[^/]+\/chat-images\/.+/ },
});
let state = {}, queries = [], calls = [], opened = 0;
const { CampaignAdReview } = loadTs(path.join(__dirname, "../src/components/channels/CampaignAdReview.tsx"), {
  react: { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) },
  "react-native": { Image: "Image", Text: "Text", View: "View", StyleSheet: { create: (s) => s } },
  "@tanstack/react-query": { useQuery: (q) => { queries.push(q); return q.queryKey[0] === "campaign-ad-image" ? { data: "https://signed.example/image" } : state; } },
  "@zavi/shared": shared,
  "../../features/channels/managedCampaignsHooks": { campaignFetch: async (url) => { calls.push(url); return { ...state.data, signed_url: "https://signed.example/image" }; } },
  "../../features/workspaces/useActiveTenant": { useActiveTenant: () => "tenant-one" },
  "../reply/ui": { CardButton: "Button" },
  "./CampaignWorkspace": { openCampaignWeb: () => { opened++; return Promise.resolve(); } },
  "../../theme/tokens": { font: { family: {} }, radius: {}, space: {} },
  "../../theme/theme": { useStyles: () => ({}) },
});
function expand(node) {
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") return expand(node.type(node.props));
  return { ...node, children: (node.children || []).map(expand) };
}
const text = (n) => typeof n === "string" ? n : (n?.children || []).map(text).join(" ");
const find = (n, type) => !n || typeof n !== "object" ? [] : [...(n.type === type ? [n] : []), ...(n.children || []).flatMap((c) => find(c, type))];
test("saved nested projection shows exact UTC seconds and private images use the signed reader", async () => {
  queries = []; calls = [];
  state = { data: { editable: true, limitations: [], review: { creatives: [{ title: "Local rentals", body: "Find your car", image_path: "tenants/t/chat-images/a.png" }], schedule: { start: "2026-10-24T09:00:57Z", end: "2026-10-24T12:00:59Z" }, cost: "$25/day" } } };
  const tree = expand(CampaignAdReview({ actionId: "card-one", actionStatus: "pending", execStatus: null }));
  assert.match(text(tree), /2026-10-24T09:00:57Z/);
  assert.match(text(tree), /Local rentals/);
  assert.equal(find(tree, "Image")[0].props.source.uri, "https://signed.example/image");
  for (const q of queries) await q.queryFn();
  assert.deepEqual(calls, ["/api/channel-actions/card-one/ad-review", "/api/chat/image-url?path=tenants%2Ft%2Fchat-images%2Fa.png"]);
  assert.ok(queries.every((q) => q.queryKey[1] === "tenant-one"));
  find(tree, "Button")[0].props.onPress();
  assert.equal(opened, 1);
});
test("an unreadable preview keeps the web review available without a write", () => {
  state = { isError: true }; calls = [];
  const tree = expand(CampaignAdReview({ actionId: "card-two" }));
  assert.match(text(tree), /preview could not be read/);
  assert.equal(find(tree, "Button")[0].props.label, "View action on web");
  assert.equal(find(tree, "Image").length, 0);
  assert.deepEqual(calls, []);
});


test("closed or executing actions never invite editing or approval even with a stale editable preview", () => {
  for (const [actionStatus, execStatus] of [["rejected", null], ["completed", "executed"], ["pending", "queued"], ["pending", "dispatching"]]) {
    state = { data: { editable: true, limitations: [], review: { creatives: [] } } };
    const tree = expand(CampaignAdReview({ actionId: "old-card", actionStatus, execStatus }));
    assert.match(text(tree), /read-only preview/);
    assert.doesNotMatch(text(tree), /then approve/);
    assert.equal(find(tree, "Button")[0].props.label, "View action on web");
  }
});
test("server editability and reason govern a pending card, and status scopes a fresh read", () => {
  queries = [];
  state = { data: { editable: false, limitations: ["This campaign is already approved."], review: { creatives: [] } } };
  let tree = expand(CampaignAdReview({ actionId: "card", actionStatus: "pending", execStatus: null }));
  assert.match(text(tree), /already approved/);
  assert.equal(find(tree, "Button")[0].props.label, "View action on web");
  state.data.editable = true;
  state.data.limitations = [];
  tree = expand(CampaignAdReview({ actionId: "card", actionStatus: "pending", execStatus: null }));
  assert.equal(find(tree, "Button")[0].props.label, "Review and edit on web");
  assert.deepEqual(Array.from(queries[0].queryKey.slice(2)), ["card", "pending", null]);
});
