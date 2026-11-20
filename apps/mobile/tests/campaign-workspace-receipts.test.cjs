const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");
let states = [], slot = 0, tenant = "one", changes = 0, entityRows = [];
const React = {
  useState: (initial) => { const i = slot++; if (!(i in states)) states[i] = initial; return [states[i], (value) => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; },
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
};
const model = loadTs(path.join(__dirname, "../src/features/channels/managedCampaigns.ts"), { "@zavi/shared": { isAdImagePath: () => false } });
const { CampaignWorkspace } = loadTs(path.join(__dirname, "../src/components/channels/CampaignWorkspace.tsx"), {
  react: React,
  "react-native": { Platform: { OS: "ios" }, Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View", StyleSheet: { create: (s) => s } },
  "@tanstack/react-query": { useQueryClient: () => ({ invalidateQueries() {} }) },
  "../../features/workspaces/useActiveTenant": { useActiveTenant: () => tenant },
  "expo-web-browser": { openBrowserAsync: () => Promise.resolve() },
  "../AppBottomSheet": { AppBottomSheet: "Sheet" }, "../Icon": { Icon: "Icon" }, "../Skeleton": { SkeletonBlock: "Skeleton" }, "../OptionSheet": { OptionSheet: "OptionSheet" },
  "../reply/ui": { CardButton: "Button" }, "../growth/StoryKit": { TextLink: "Link" },
  "./CampaignEditor": { CampaignEditor: "CampaignEditor" }, "./CampaignAssets": { AdSheet: "AdSheet", GroupSheet: "GroupSheet" },
  "../../features/channels/managedCampaigns": model,
  "../../features/channels/managedCampaignsHooks": { useEntities: () => ({ data: entityRows }), useWallet: () => ({ data: null }), useReport: () => ({}) },
  "../../theme/tokens": { font: { family: {} }, radius: {}, space: {} }, "../../theme/theme": { useStyles: () => ({}), useTheme: () => ({ colors: {} }) },
});
const find = (n, type) => !n || typeof n !== "object" ? [] : [...(n.type === type ? [n] : []), ...(n.children || []).flatMap((c) => find(c, type))];
const text = (n) => typeof n === "string" ? n : (n?.children || []).map(text).join(" ");
const render = () => { slot = 0; return CampaignWorkspace({ dashboard: { campaigns: [], currency: "USD" }, loading: false, days: 7, onChanged: () => changes++ }); };
const campaign = { id: "campaign-one", name: "Paused QA", status: "paused", bidding_type: "clicks" };
test("first creation retains receipt and next step while provider inventory is empty; tenant switch hides it", () => {
  states = []; tenant = "one";
  let tree = render();
  find(tree, "Button").find((n) => n.props.label === "Create a campaign").props.onPress();
  tree = render();
  find(tree, "CampaignEditor")[0].props.onSaved(campaign);
  tree = render();
  assert.match(text(tree), /Campaign created and paused/);
  find(tree, "Button").find((n) => n.props.label === "Add ad group").props.onPress();
  tree = render();
  assert.equal(find(tree, "GroupSheet")[0].props.campaign.id, campaign.id);
  assert.equal(find(tree, "GroupSheet")[0].props.open, true);
  find(tree, "GroupSheet")[0].props.onSaved({ id: "group-one", status: "paused" });
  tree = render();
  assert.match(text(tree), /reference\s+group-one/);
  const before = changes;
  find(tree, "Button").find((n) => n.props.label === "Refresh").props.onPress();
  assert.equal(changes, before + 1);
  entityRows = [{ id: "group-one" }];
  assert.doesNotMatch(text(render()), /has not listed/);
  tenant = "two";
  assert.doesNotMatch(text(render()), /Campaign created and paused|group-one|Campaign saved paused/);
});
