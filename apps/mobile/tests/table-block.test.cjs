const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const opened = [];
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
};
const { TableBlock } = loadTs(path.join(__dirname, "../src/components/reply/uiblocks/TableBlock.tsx"), {
  react: React,
  "react-native": {
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    StyleSheet: { create: (s) => s },
    Text: "Text",
    View: "View",
  },
  "expo-web-browser": { openBrowserAsync: (url) => (opened.push(url), Promise.resolve()) },
  "../../../theme/tokens": { font: { family: {} }, radius: {}, space: {} },
  "../../../theme/theme": { useStyles: () => new Proxy({}, { get: (_, key) => String(key) }) },
  "../../UnderlinedText": { UnderlinedText: "UnderlinedText" },
  "../ui": { Card: "Card" },
});

function find(node, pred, out = []) {
  if (node && typeof node === "object") {
    if (pred(node)) out.push(node);
    for (const c of node.children ?? []) find(c, pred, out);
  }
  return out;
}
const text = (node) =>
  typeof node === "string" ? node : node && typeof node === "object" ? (node.children ?? []).map(text).join("") : "";
const has = (node, style) => [].concat(node.props.style ?? []).flat(Infinity).includes(style);
const rowsOf = (tree) => find(tree, (n) => n.type === "View" && has(n, "row"));
const cellsOf = (row) => row.children.filter((c) => c && c.type !== undefined);
const grid = (tree) => rowsOf(tree).map((r) => cellsOf(r).map(text));

test("a null or missing cell is drawn as a dash, never blank or the word null", () => {
  const tree = TableBlock({
    block: { kind: "table", title: "Signups", columns: ["Channel", "Signups", "Cost"], rows: [["Meta", 12, null], ["Google", null], ["", 0, "n/a"]] },
  });
  assert.deepEqual(grid(tree), [
    ["Channel", "Signups", "Cost"],
    ["Meta", "12", "—"],
    ["Google", "—", "—"],
    ["", "0", "n/a"],
  ]);
});

test("the biggest table the server allows (8 columns, 50 rows) draws every cell", () => {
  const columns = Array.from({ length: 8 }, (_, i) => `C${i}`);
  const rows = Array.from({ length: 50 }, (_, r) => columns.map((_, c) => (c === 3 && r % 7 === 0 ? null : `r${r}c${c}`)));
  const g = grid(TableBlock({ block: { kind: "table", title: "Big", columns, rows } }));
  assert.equal(g.length, 51, "header + 50 rows");
  assert.ok(g.every((row) => row.length === 8));
  assert.equal(g[50][7], "r49c7");
  assert.equal(g[1][3], "—");
  assert.equal(g[2][3], "r1c3");
});

test("a column of numbers (also $, % and thousands) is right-aligned, a mixed or empty one is not", () => {
  const tree = TableBlock({
    block: {
      kind: "table",
      title: "Mix",
      columns: ["Money", "Rate", "Name", "Empty", "Mixed"],
      rows: [
        ["$4,210", "11.3%", "Alpha", null, 5],
        [1587, "-2%", "Beta", null, "n/a"],
        [null, 0, "Gamma", null, 7],
      ],
    },
  });
  const [header, ...body] = rowsOf(tree).map(cellsOf);
  assert.deepEqual(header.map((c) => has(c, "numeric")), [true, true, false, false, false]);
  assert.deepEqual(body[0].map((c) => has(c, "numeric")), [true, true, false, false, false]);
});

test("an https link becomes a tappable open link that opens that address; other text stays text", () => {
  opened.length = 0;
  const tree = TableBlock({
    block: {
      kind: "table",
      title: "Pages",
      columns: ["Page", "Link"],
      rows: [["Home", "https://example.com/a?b=1"], ["Docs", "http://example.com/insecure"], ["Blog", "see https://example.com"]],
    },
  });
  const links = find(tree, (n) => n.type === "Pressable");
  assert.equal(links.length, 1);
  assert.equal(links[0].props.accessibilityRole, "link");
  assert.equal(text(links[0]), "open ↗");
  links[0].props.onPress();
  assert.deepEqual(opened, ["https://example.com/a?b=1"]);
  assert.deepEqual(grid(tree).slice(2).map((r) => r[1]), ["http://example.com/insecure", "see https://example.com"]);
});

test("the title and the footnote are drawn; no footnote draws none", () => {
  const block = { kind: "table", title: "Spend", columns: ["A"], rows: [["x"]] };
  const without = text(TableBlock({ block }));
  assert.match(without, /^Spend/);
  assert.equal(find(TableBlock({ block }), (n) => n.props.style === "note").length, 0);
  const withNote = TableBlock({ block: { ...block, note: "*Sep 1-25 only." } });
  assert.deepEqual(find(withNote, (n) => n.props.style === "note").map(text), ["*Sep 1-25 only."]);
});
