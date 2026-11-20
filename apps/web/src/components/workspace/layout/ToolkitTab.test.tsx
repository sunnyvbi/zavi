import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  location: "/workspace#integrations",
  role: "owner" as string | null,
  replaced: [] as string[],
  dataAccessProps: [] as Array<{ entryId?: string | null }>,
}));

vi.mock("../navigation/useWorkspaceLocation", () => ({ useWorkspaceLocation: () => h.location }));
vi.mock("../navigation/workspaceRoutes", async (orig) => ({
  ...(await orig<typeof import("../navigation/workspaceRoutes")>()),
  readWorkspaceLocation: () => h.location,
  replaceWorkspaceLocation: (href: string) => {
    h.replaced.push(href);
  },
}));
vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => ({ role: h.role }) }));
vi.mock("../SettingsTab", () => ({ SettingsTab: () => <div>integrations panel</div> }));
vi.mock("./ToolkitSkills", () => ({ ToolkitSkills: () => <div>skills panel</div> }));
vi.mock("./SkillsCreateMenu", () => ({ SkillsCreateMenu: () => null }));
vi.mock("./DataAccessTab", () => ({
  DataAccessTab: (props: { entryId?: string | null }) => {
    h.dataAccessProps.push(props);
    return <div>data access panel</div>;
  },
}));

import { ToolkitTab } from "./ToolkitTab";

beforeEach(() => {
  h.location = "/workspace#integrations";
  h.role = "owner";
  h.replaced = [];
  h.dataAccessProps = [];
});
afterEach(() => cleanup());

describe("ToolkitTab Data access tab", () => {
  it.each(["owner", "admin"])("%s sees the tab and can open it", (role) => {
    h.role = role;
    render(<ToolkitTab />);
    fireEvent.click(screen.getByRole("tab", { name: "Data access" }));
    expect(h.replaced.at(-1)).toBe("/workspace#data-access");
  });

  it.each(["member", "viewer", null])("%s does not see the tab", (role) => {
    h.role = role;
    render(<ToolkitTab />);
    expect(screen.queryByRole("tab", { name: "Data access" })).toBeNull();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Integrations", "Skills"]);
  });

  it("a member on a #data-access link lands on Integrations, not the log", () => {
    h.role = "member";
    h.location = "/workspace?tab=brain&access=x#data-access";
    render(<ToolkitTab />);
    expect(screen.getByText("integrations panel")).toBeDefined();
    expect(screen.queryByText("data access panel")).toBeNull();
  });

  it("an owner deep link passes the entry id to the log", () => {
    const id = "66666666-6666-4666-8666-666666666666";
    h.location = `/workspace?tab=brain&access=${id}#data-access`;
    render(<ToolkitTab />);
    expect(screen.getByText("data access panel")).toBeDefined();
    expect(screen.getByRole("tab", { name: "Data access" }).getAttribute("aria-selected")).toBe("true");
    expect(h.dataAccessProps.at(-1)?.entryId).toBe(id);
  });

  it("?entry= is accepted as an alias", () => {
    h.location = "/workspace?tab=brain&entry=abc#data-access";
    render(<ToolkitTab />);
    expect(h.dataAccessProps.at(-1)?.entryId).toBe("abc");
  });
});

describe("ToolkitTab sliding indicator", () => {
  const saved = (["offsetLeft", "offsetTop", "offsetWidth", "offsetHeight"] as const).map(
    (key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const,
  );
  beforeEach(() => {
    const tabIndex = (el: HTMLElement) =>
      el.parentElement ? Array.from(el.parentElement.querySelectorAll("[role=tab]")).indexOf(el) : -1;
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
      configurable: true,
      get(this: HTMLElement) {
        return tabIndex(this) * 150 + 4;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get: () => 2 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return (this.textContent ?? "").length * 10;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 34 });
  });
  afterEach(() => {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(HTMLElement.prototype, key, desc);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  });

  it("one indicator inside the tablist slides from Integrations to Skills and no tab paints its own underline", () => {
    const { rerender } = render(<ToolkitTab />);
    const list = screen.getByRole("tablist", { name: "Connectors" });
    const indicators = list.querySelectorAll('[data-testid="sliding-indicator"]');
    expect(indicators).toHaveLength(1);
    const indicator = indicators[0] as HTMLElement;
    expect(indicator.style.transform).toBe("translate(4px, 2px)");
    expect(indicator.style.width).toBe("120px");
    expect(indicator.className).toMatch(/(^|\s)opacity-100(\s|$)/);
    expect(indicator.className).toMatch(/(^|\s)border-ink(\s|$)/);

    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(h.replaced.at(-1)).toBe("/workspace#skills");
    h.location = h.replaced.at(-1)!;
    rerender(<ToolkitTab />);

    expect(screen.getByText("skills panel")).toBeDefined();
    expect(screen.getByRole("tab", { name: "Skills" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Integrations" }).getAttribute("aria-selected")).toBe("false");
    expect(list.querySelectorAll('[data-testid="sliding-indicator"]')).toHaveLength(1);
    expect(list.querySelector('[data-testid="sliding-indicator"]')).toBe(indicator);
    expect(indicator.style.transform).toBe("translate(154px, 2px)");
    expect(indicator.style.width).toBe("60px");
    for (const tab of screen.getAllByRole("tab")) expect(tab.className).not.toMatch(/(^|\s)border-ink(\s|$)/);
  });
});
