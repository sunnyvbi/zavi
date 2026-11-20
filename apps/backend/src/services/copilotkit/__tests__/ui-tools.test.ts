
import { describe, it, expect } from "vitest";
import { CHART_VARIANTS, ChartBlockSchema, HtmlBlockSchema, KpiBlockSchema, parseUiBlock, PostsBlockSchema, TableBlockSchema } from "@zavi/shared";
import { htmlRendersBlank, readUiTools, SHOW_TOOLS, UiToolsSchema, UI_TOOL_NAMES } from "../ui-tools";

const decl = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  description: "d",
  parameters: { type: "object", properties: { kind: { type: "string" } } },
  ...over,
});

describe("readUiTools", () => {
  it("keeps only the three gated names", () => {
    const out = readUiTools({ ui_tools: [decl("open_tab"), decl("open_agent"), decl("open_approval")] });
    expect(out.map((t) => t.name)).toEqual([...UI_TOOL_NAMES]);
  });

  it("rejects the whole list on an unknown name, an empty schema, or an oversized one", () => {
    expect(readUiTools({ ui_tools: [decl("delete_everything")] })).toEqual([]);
    expect(readUiTools({ ui_tools: [decl("open_tab", { parameters: {} })] })).toEqual([]);
    expect(readUiTools({ ui_tools: [decl("open_tab", { parameters: { type: "object", x: "a".repeat(3000) } })] })).toEqual([]);
    expect(UiToolsSchema.safeParse(Array.from({ length: 9 }, () => decl("open_tab"))).success).toBe(false);
  });

  it("is [] for a missing / malformed payload", () => {
    expect(readUiTools(null)).toEqual([]);
    expect(readUiTools({})).toEqual([]);
    expect(readUiTools({ ui_tools: "nope" })).toEqual([]);
  });
});

describe("block schemas", () => {
  it("chart: strict, bounded, defaults to bar", () => {
    const ok = ChartBlockSchema.parse({ kind: "chart", title: "Signups", series: [{ label: "Mon", value: 3 }] });
    expect(ok.variant).toBe("bar");
    expect(ChartBlockSchema.safeParse({ kind: "chart", title: "x", series: [], }).success).toBe(false);
    expect(ChartBlockSchema.safeParse({ kind: "chart", title: "x", series: [{ label: "a", value: 1 }], html: "<b>" }).success).toBe(false);
    expect(ChartBlockSchema.safeParse({ kind: "chart", title: "x", series: Array.from({ length: 31 }, (_, i) => ({ label: `${i}`, value: i })) }).success).toBe(false);
  });

  it("chart: colors are optional, hex-only, and reject anything that can reference something else", () => {
    const base = { kind: "chart" as const, title: "YoY", series: [{ label: "2024", value: 1.2 }, { label: "2025", value: -2.9 }] };
    expect(ChartBlockSchema.parse(base).colors).toBeUndefined();
    expect(ChartBlockSchema.safeParse({ ...base, colors: { positive: "#16a34a", negative: "#dc2626" } }).success).toBe(true);
    expect(ChartBlockSchema.safeParse({ ...base, colors: { series: "#0f0" } }).success).toBe(true);
    expect(ChartBlockSchema.safeParse({ ...base, colors: {} }).success).toBe(true);
    for (const bad of ["url(#evil)", "var(--c-ink)", "red", "rgb(255,0,0)", "rgba(0,0,0,.5)", "#16a34", "#1234567", "16a34a", "#ggg", "#fff;background:url(x)", ""]) {
      expect(ChartBlockSchema.safeParse({ ...base, colors: { series: bad } }).success, `expected ${JSON.stringify(bad)} rejected`).toBe(false);
    }
    expect(ChartBlockSchema.safeParse({ ...base, colors: { border: "#fff" } }).success).toBe(false);
    const parsed = parseUiBlock({ ...base, colors: { positive: "#00ff00" } });
    expect(parsed?.kind === "chart" ? parsed.colors?.positive : null).toBe("#00ff00");
    expect(parseUiBlock({ ...base, colors: { positive: "url(#x)" } })).toBeNull();
  });

  it("htmlRendersBlank: catches a container only a script could fill", () => {
    const incident =
      '<!DOCTYPE html><html><head><style>body{margin:0;padding:16px;background:#fff}</style></head>' +
      '<body><div style="font-size:15px">Tesla Revenue — Year-over-Year Growth</div>' +
      '<div style="font-size:11px">Annual revenue growth rate · Source: stockanalysis.com</div>' +
      '<svg id="c" width="580" height="410"></svg></body></html>';
    expect(htmlRendersBlank(incident)).toBe(true);
    expect(htmlRendersBlank('<body><canvas id="c" width="500"></canvas></body>')).toBe(true);
    expect(htmlRendersBlank('<svg viewBox="0 0 580 410"></svg>')).toBe(true);
    expect(htmlRendersBlank('<svg style="height:400px"></svg>')).toBe(true);
  });

  it("htmlRendersBlank: leaves a genuinely drawn card alone", () => {
    expect(
      htmlRendersBlank('<svg width="100" height="50"><rect x="0" y="0" width="20" height="40" fill="#3b82f6"/></svg>'),
    ).toBe(false);
    expect(htmlRendersBlank("<table><tr><td>2025</td><td>-2.9%</td></tr></table>")).toBe(false);
    expect(htmlRendersBlank('<div style="width:40%;background:#16a34a">bar</div>')).toBe(false);
    expect(
      htmlRendersBlank('<svg><circle r="4"/></svg><svg class="spacer"></svg>'),
    ).toBe(false);
    expect(htmlRendersBlank("<b>hi</b><svg/>")).toBe(false);
    expect(htmlRendersBlank('<svg width="10" height="10"></svg>')).toBe(false);
  });

  it("show_chart's description sends every colour request to show_chart, not html", () => {
    const chart = SHOW_TOOLS.show_chart.description;
    expect(chart).toMatch(/never show_html/i);
    expect(chart).toMatch(/hex literal/i);
    expect(chart).toMatch(/SAME series/i);
    const html = SHOW_TOOLS.show_html.description;
    expect(html.startsWith("NOT FOR CHARTS.")).toBe(true);
    expect(html).toMatch(/is show_chart with `colors`, never this tool/i);
    expect(html).toMatch(/empty <svg> or a <canvas>/i);
    expect(html).toMatch(/scripts? (may be allowed|OFF)/i);
  });

  it("table + posts have the same posture", () => {
    expect(TableBlockSchema.safeParse({ kind: "table", title: "t", columns: ["a"], rows: [["x", 1, null]] }).success).toBe(true);
    expect(TableBlockSchema.safeParse({ kind: "table", title: "t", columns: [], rows: [["x"]] }).success).toBe(false);
    expect(PostsBlockSchema.safeParse({ kind: "posts", title: "p", posts: [{ channel: "linkedin", payload: { text: "hi" } }] }).success).toBe(true);
    expect(PostsBlockSchema.safeParse({ kind: "posts", title: "p", posts: [] }).success).toBe(false);
  });

  it("kpi + html blocks: strict and bounded; chart accepts the six variants", () => {
    expect(KpiBlockSchema.safeParse({ kind: "kpi", title: "t", items: [{ label: "Spend", value: "$1", delta: "+1%", tone: "up" }] }).success).toBe(true);
    expect(KpiBlockSchema.safeParse({ kind: "kpi", title: "t", items: [] }).success).toBe(false);
    expect(HtmlBlockSchema.safeParse({ kind: "html", title: "t", html: "<svg/>", height: 300 }).success).toBe(true);
    expect(HtmlBlockSchema.safeParse({ kind: "html", title: "t", html: "x".repeat(200 * 1024 + 1) }).success).toBe(false);
    for (const v of CHART_VARIANTS) expect(ChartBlockSchema.safeParse({ kind: "chart", title: "t", variant: v, series: [{ label: "a", value: 1 }] }).success).toBe(true);
    expect(ChartBlockSchema.safeParse({ kind: "chart", title: "t", variant: "radar", series: [{ label: "a", value: 1 }] }).success).toBe(false);
  });

  it("parseUiBlock returns null for anything else", () => {
    expect(parseUiBlock({ kind: "iframe", src: "https://evil" })).toBeNull();
    expect(parseUiBlock("nope")).toBeNull();
    expect(parseUiBlock({ kind: "table", title: "t", columns: ["a"], rows: [["x"]] })?.kind).toBe("table");
  });

  it("every show_* tool omits `kind` from its input (the tool fixes it)", () => {
    for (const [name, def] of Object.entries(SHOW_TOOLS)) {
      expect(name.startsWith("show_")).toBe(true);
      expect("kind" in def.schema.shape).toBe(false);
    }
  });
});
