// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readdirSync } from "node:fs";
import { STATIC_TITLES } from "../layout/shared";
import { STATIC_TAB_TITLES, migrateStaticTabTitles } from "../WorkspaceShell";
import { GrowthCompanyCard } from "./GrowthCompanyCard";
import { GrowthConnections } from "./GrowthConnections";

const apiFetchMock = vi.fn(async (path: string) => {
  const body: Record<string, unknown> = {
    "/api/connectors": { connectors: [] },
    "/api/connectors/company-facts": { facts: [] },
    "/api/connectors/recommendations": { recommendations: [RECOMMENDATION] },
  };
  return { ok: true, status: 200, json: async () => body[path] ?? { ok: true } } as unknown as Response;
});
vi.mock("@/lib/api", () => ({ apiFetch: (p: string) => apiFetchMock(p) }));

vi.mock("../settings/useSlackScopeStatus", () => ({
  useSlackScopeStatus: () => [],
  useSlackScopeState: () => ({ missing: [], settled: true }),
}));

const RECOMMENDATION = {
  slug: "operator_db",
  name: "Operator DB",
  rationale:
    "Your marketplace DB is the ground truth for listings, users, and transactions — connecting it unlocks the agents that actually move GMV and retention.",
  connected: false,
  recommended: true,
};

afterEach(cleanup);

const SRC = (f: string) => readFileSync(join(__dirname, f), "utf8");
const CHAT_COLUMN = readFileSync(join(__dirname, "../layout/ChatColumn.tsx"), "utf8");
const CONTEXT_PANEL = readFileSync(join(__dirname, "../layout/ContextPanel.tsx"), "utf8");

describe("the Growth page (Your CGO) is named once", () => {
  it("gives the tab the same name the sidebar uses to open it", () => {
    expect(STATIC_TITLES.autopilot).toBe("Your CGO");
    expect(CONTEXT_PANEL).toContain("<CgoNavItem");
    expect(CONTEXT_PANEL).not.toContain('label="Growth Strategy"');
    expect(CONTEXT_PANEL.includes('openStatic("autopilot")')).toBe(true);
  });

  it("does not restate that name inside the page, nor keep the row's menu", () => {
    const page = SRC("GrowthCommandCenter.tsx");
    expect(page).not.toContain("<h1");
    expect(page).not.toContain(STATIC_TITLES.autopilot);
    expect(page).not.toContain("Plan options");
    expect(page).not.toContain("Start over");
    expect(page).not.toContain("growth-strategy/reset");
  });

  it("carries no chat toggle: the side chat's own header and rail open and fold it", () => {
    expect(SRC("GrowthCommandCenter.tsx")).not.toContain("leading");
  });

  it("draws the compact page title bold, and bigger than the body text around it", () => {
    const title = /className="hidden min-w-0 flex-1 truncate px-2 text-center text-\[(\d+)px\] (font-\w+)/.exec(CHAT_COLUMN);
    expect(title).not.toBeNull();
    expect(Number(title![1])).toBeGreaterThanOrEqual(20);
    expect(title![2]).toBe("font-bold");
  });
});

describe("the Your CGO name reaches every door", () => {
  const SRC_ROOT = join(__dirname, "../../..");

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
    }
    return out;
  }

  it("keeps the shell's tab-title table and the nav's table saying the same thing", () => {
    expect(STATIC_TAB_TITLES.autopilot).toBe("Your CGO");
    expect(STATIC_TAB_TITLES.autopilot).toBe(STATIC_TITLES.autopilot);
  });

  it("has no door left that opens this tab under the retired name", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const body = readFileSync(file, "utf8");
      for (const m of body.matchAll(/(title:\s*|(?<!aria-)label=)"Autopilot"/g)) {
        offenders.push(`${file.slice(SRC_ROOT.length + 1)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("renames a tab that was already open under the old name", () => {
    const [renamed] = migrateStaticTabTitles([
      { id: "autopilot-default", kind: "autopilot", title: "Autopilot", payload: { kind: "autopilot" }, dirty: false, pinned: false },
    ] as never);
    expect((renamed as { title: string }).title).toBe("Your CGO");
  });

  it("renames a tab saved under the 2026-09 name, Growth Strategy", () => {
    const [renamed] = migrateStaticTabTitles([
      { id: "autopilot-default", kind: "autopilot", title: "Growth Strategy", payload: { kind: "autopilot" }, dirty: false, pinned: false },
    ] as never);
    expect((renamed as { title: string }).title).toBe("Your CGO");
  });

  it("does not touch a tab the founder renamed themselves, nor any other kind", () => {
    const tabs = migrateStaticTabTitles([
      { id: "a", kind: "autopilot", title: "Autopilot", customTitle: true, payload: { kind: "autopilot" }, dirty: false, pinned: false },
      { id: "b", kind: "channels", title: "Autopilot", payload: { kind: "channels" }, dirty: false, pinned: false },
      { id: "c", kind: "autopilot", title: "My plan", payload: { kind: "autopilot" }, dirty: false, pinned: false },
    ] as never) as unknown as Array<{ title: string }>;
    expect(tabs.map((t) => t.title)).toEqual(["Autopilot", "Autopilot", "My plan"]);
  });
});

describe("editing Company Details", () => {
  const facts = [
    { key: "company_name", value_text: "Airbnb" },
    { key: "what_we_sell", value_text: "Holiday rentals" },
  ];

  async function openEditor() {
    render(<GrowthCompanyCard fallbackName="Airbnb" canEdit sourcedFacts={undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit company details" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit company details" }));
  }

  it("fills both fields with a surface of their own, not the card behind them", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      const body: Record<string, unknown> = {
        "/api/connectors/company-facts": { facts },
        "/api/connectors": { connectors: [] },
        "/api/connectors/recommendations": { recommendations: [RECOMMENDATION] },
      };
      return { ok: true, status: 200, json: async () => body[path] ?? { ok: true } } as unknown as Response;
    });
    await openEditor();

    for (const label of ["Company name", "What the company does"]) {
      const field = screen.getByLabelText(label);
      const cls = field.getAttribute("class") ?? "";
      expect(cls, `${label} is see-through`).not.toContain("bg-transparent");
      expect(cls, `${label} has no fill`).toMatch(/\bbg-creamDeep\b/);
      expect(cls, `${label} does not highlight on focus`).toMatch(/\bfocus:ring-2\b/);
      expect(cls).toMatch(/\bfocus:ring-\w+/);
    }
  });
});

describe("a connector recommendation in a narrow pane", () => {
  async function tile() {
    render(<GrowthConnections anyMeasured={false} />);
    const connect = await screen.findByRole("button", { name: "Connect Operator DB" });
    return { connect, tile: connect.closest("li")! };
  }

  it("sizes its columns off the pane it sits in, not the window", async () => {
    const { tile: t } = await tile();
    const grid = t.closest("ul")!;
    expect(grid.parentElement?.getAttribute("class")).toContain("[container-type:inline-size]");
    const cls = grid.getAttribute("class") ?? "";
    expect(cls).toMatch(/\bgrid-cols-1\b/);
    expect(cls).toContain("[@container(min-width:");
    expect(cls).not.toMatch(/@media|\bmd:|\blg:/);
  });

  it("shows the name only, with the reason one hover away", async () => {
    await tile();
    const name = screen.getByText("Operator DB");
    expect(name.getAttribute("class")).toMatch(/\btext-sm\b/);
    expect(screen.queryByText(/ground truth for listings/)).toBeNull();
    expect(name.closest("li")?.getAttribute("title")).toMatch(/ground truth for listings/);
  });

  it("keeps Connect a small card action, not a form submit or a full-width bar", async () => {
    const { connect } = await tile();
    expect(connect.getAttribute("type")).toBe("button");
    expect(connect.getAttribute("class") ?? "").not.toMatch(/\bw-full\b/);
    const column = screen.getByText("Operator DB").parentElement;
    expect(column?.getAttribute("class")).toMatch(/\bflex-1\b/);
    expect(column?.getAttribute("class")).toMatch(/\bmin-w-0\b/);
  });
});
