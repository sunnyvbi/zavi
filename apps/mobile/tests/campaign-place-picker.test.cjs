const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");
const shared = loadTs(path.join(__dirname, "../../../packages/shared/src/channels/managed-campaigns.ts"));
let slot = 0, picked = [];
const places = [
  { id: "city", name: "New York", type: "city", region_code: "NY", country_code: "US" },
  { id: "state", name: "New York", type: "state", country_code: "US" },
];
const { PlacePicker } = loadTs(path.join(__dirname, "../src/components/channels/CampaignEditor.tsx"), {
  react: { useEffect() {}, useState: () => [["New York", places, false][slot++], () => {}], createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) },
  "react-native": { Pressable: "Pressable", Text: "Text", View: "View", StyleSheet: { create: (s) => s } },
  "@zavi/shared": shared,
  "../AppBottomSheet": {}, "../reply/ui": {}, "./CampaignParts": {}, "../Icon": { Icon: "Icon" }, "../ZaviTextField": { ZaviTextField: "Field" },
  "../../features/channels/managedCampaigns": {}, "../../features/channels/managedCampaignsHooks": {},
  "../../theme/tokens": { font: { family: {} }, radius: {}, space: {} },
  "../../theme/theme": { useStyles: () => ({}), useTheme: () => ({ colors: {} }) },
});
const buttons = (node) => !node || typeof node !== "object" ? [] : [...(node.type === "Pressable" ? [node] : []), ...(node.children || []).flatMap(buttons)];
test("same-named results and selected chips announce their provider location context", () => {
  slot = 0;
  let tree = PlacePicker({ label: "Include places", picked: [], onChange: (value) => { picked = value; } });
  let choices = buttons(tree);
  assert.equal(choices[0].props.accessibilityLabel, "Add New York · city · NY · US");
  assert.equal(choices[1].props.accessibilityLabel, "Add New York · state · US");
  choices[1].props.onPress();
  assert.equal(picked[0].id, "state");
  slot = 0;
  tree = PlacePicker({ label: "Include places", picked, onChange: (value) => { picked = value; } });
  const remove = buttons(tree).find((n) => n.props.accessibilityLabel.startsWith("Remove"));
  assert.equal(remove.props.accessibilityLabel, "Remove New York · state · US");
  remove.props.onPress();
  assert.equal(picked.length, 0);
});
