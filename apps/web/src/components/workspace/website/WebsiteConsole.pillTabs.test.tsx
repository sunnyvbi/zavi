// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const jsonRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const columns = [
  { name: "id", type: "uuid", nullable: false },
  { name: "email", type: "text", nullable: false },
];
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string) => {
    if (url.includes("/app-catalog")) {
      return Promise.resolve(
        jsonRes({ connected: true, dialect: "postgres", tables: [{ name: "users", row_estimate: null, columns }] }),
      );
    }
    return Promise.resolve(
      jsonRes({
        connected: true,
        supported: true,
        dialect: "postgres",
        table: "users",
        columns,
        rows: [{ id: "u1", email: "a@example.com" }],
        row_keys: [{ id: "u1" }],
        row_versions: ["1"],
        has_more: false,
        masked_columns: [],
        writable: true,
      }),
    );
  },
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ role: "owner", openTab: vi.fn() }),
}));

import { PillTabs, UsersView, __resetAppCatalogInflight } from "./WebsiteConsole";

const LAYOUT: Record<string, { left: number; width: number }> = {
  Users: { left: 3, width: 70 },
  "Pending requests": { left: 77, width: 160 },
  Data: { left: 3, width: 56 },
  Schema: { left: 63, width: 80 },
};

const originals = {
  left: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft"),
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
};

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get(this: HTMLElement) {
      return LAYOUT[this.textContent ?? ""]?.left ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return LAYOUT[this.textContent ?? ""]?.width ?? 0;
    },
  });
});

afterAll(() => {
  if (originals.left) Object.defineProperty(HTMLElement.prototype, "offsetLeft", originals.left);
  if (originals.width) Object.defineProperty(HTMLElement.prototype, "offsetWidth", originals.width);
});

afterEach(() => {
  cleanup();
  __resetAppCatalogInflight();
  vi.useRealTimers();
});

function indicator(root: HTMLElement): HTMLElement {
  const el = root.querySelector<HTMLElement>("[data-testid='pill-indicator']");
  if (!el) throw new Error("no sliding indicator");
  return el;
}

async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

describe("the Users / Pending requests switch", () => {
  it("slides one indicator from Users to Pending requests instead of swapping backgrounds", async () => {
    render(<UsersView deployedUrl={null} />);
    const list = await screen.findByRole("tablist");
    const users = within(list).getByRole("tab", { name: "Users" });
    const pending = within(list).getByRole("tab", { name: "Pending requests" });

    expect(users.getAttribute("aria-selected")).toBe("true");
    expect(indicator(list).style.transform).toBe("translateX(3px)");
    expect(indicator(list).style.width).toBe("70px");
    expect(users.className).not.toContain("bg-white");

    await nextFrame();
    fireEvent.click(pending);

    expect(pending.getAttribute("aria-selected")).toBe("true");
    expect(users.getAttribute("aria-selected")).toBe("false");
    expect(indicator(list).style.transform).toBe("translateX(77px)");
    expect(indicator(list).style.width).toBe("160px");
    expect(indicator(list).style.transition).toContain("transform 380ms");
    expect(indicator(list).style.transition).toContain("width 380ms");
    expect(pending.className).not.toContain("bg-white");
    expect(list.querySelectorAll("[data-testid='pill-indicator']")).toHaveLength(1);
  });
});

describe("PillTabs", () => {
  it("does not animate the first paint, only later moves", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PillTabs
        value="data"
        onChange={onChange}
        options={[
          { id: "data", label: "Data" },
          { id: "schema", label: "Schema" },
        ]}
      />,
    );
    const list = screen.getByRole("tablist");
    expect(indicator(list).style.transition).toBe("none");
    fireEvent.click(within(list).getByRole("tab", { name: "Schema" }));
    expect(onChange).toHaveBeenCalledWith("schema");
    await nextFrame();
    rerender(
      <PillTabs
        value="schema"
        onChange={onChange}
        options={[
          { id: "data", label: "Data" },
          { id: "schema", label: "Schema" },
        ]}
      />,
    );
    expect(indicator(list).style.transform).toBe("translateX(63px)");
    expect(indicator(list).style.transition).toContain("transform 380ms");
  });

  it("falls back to a solid active pill when layout cannot be measured", () => {
    render(
      <PillTabs
        value="a"
        onChange={() => {}}
        options={[
          { id: "a", label: "Unmeasured A" },
          { id: "b", label: "Unmeasured B" },
        ]}
      />,
    );
    const list = screen.getByRole("tablist");
    expect(list.querySelector("[data-testid='pill-indicator']")).toBeNull();
    expect(within(list).getByRole("tab", { name: "Unmeasured A" }).className).toContain("bg-white");
  });
});
