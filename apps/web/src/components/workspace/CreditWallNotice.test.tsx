// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const openTab = vi.fn();
let role = "owner";
vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({ openTab, role }),
}));

import { CreditWallNotice } from "./CreditWallNotice";
import { wallBillingTarget } from "@/lib/workspace/openBilling";
import { WorkspaceModeWelcome } from "./ZaviWelcome";

afterEach(() => {
  cleanup();
  openTab.mockReset();
  role = "owner";
});

describe("the initial screen stays clean", () => {
  it("has no cold-start wiring for the wall", () => {
    const tab = readFileSync(
      join(process.cwd(), "src/components/workspace/AgentTab.tsx"),
      "utf8",
    );
    const welcome = tab.slice(
      tab.indexOf("<WorkspaceModeWelcome"),
      tab.indexOf("/>", tab.indexOf("<WorkspaceModeWelcome")),
    );
    expect(welcome).not.toContain("CreditWallNotice");
    expect(welcome).not.toContain("creditWall");
  });

  it("renders it in the conversation views, and only those", () => {
    const tab = readFileSync(
      join(process.cwd(), "src/components/workspace/AgentTab.tsx"),
      "utf8",
    );
    expect(tab.match(/<CreditWallNotice/g)).toHaveLength(2);
    const feed = tab.slice(tab.indexOf("{threaded && ("));
    expect(feed.slice(0, feed.indexOf("{!threaded"))).not.toContain(
      "<CreditWallNotice",
    );
    const aboveComposer = tab.slice(
      tab.indexOf("{threaded && creditWall && ("),
      tab.indexOf("<LowCreditsWarning />"),
    );
    expect(aboveComposer).toContain("<CreditWallNotice");
  });
});

describe("the 402 branch reaches the host directly", () => {
  const composer = readFileSync(
    join(process.cwd(), "src/components/workspace/Composer.tsx"),
    "utf8",
  );
  const branch = composer.slice(
    composer.indexOf("const claimInsufficientCredits"),
    composer.indexOf("return false;", composer.indexOf("const claimInsufficientCredits")),
  );

  it("calls onCreditWall from the credits branch", () => {
    expect(branch).toMatch(/onCreditWall\?\.\(\{ message: text, kind: "credits" \}\)/);
  });

  it("calls onCreditWall from the plan branch", () => {
    expect(branch).toMatch(/onCreditWall\?\.\(\{ message: text, kind: "plan", tier \}\)/);
  });

  it("does NOT report through an effect on creditError", () => {
    expect(composer).not.toMatch(/useEffect\([^)]*onCreditWall/s);
    expect(composer).not.toContain("useReportCreditWall");
  });

  it("clears on a real edit, and only on a real edit", () => {
    const composer = readFileSync(
      join(process.cwd(), "src/components/workspace/Composer.tsx"),
      "utf8",
    );
    const i = composer.indexOf("if (creditError) {");
    expect(i).toBeGreaterThan(-1);
    expect(composer.slice(i, i + 140)).toContain("onCreditWall?.(null)");
    expect(composer.match(/onCreditWall\?\.\(null\)/g)).toHaveLength(1);
  });

  it("does not clear on a thread-id effect, which the 402 itself trips", () => {
    const tab = readFileSync(
      join(process.cwd(), "src/components/workspace/AgentTab.tsx"),
      "utf8",
    );
    expect(tab).not.toMatch(/setCreditWall\(null\);\s*\}, \[threadId\]\)/);
  });

});

describe("AgentTab still owns the handler", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/workspace/AgentTab.tsx"),
    "utf8",
  );

  it("only silences the composer because it has somewhere else to put it", () => {
    expect(src).toContain("onCreditWall={handleCreditWall}");
  });
});

describe("where the wall's button lands", () => {
  it("a plan wall that names Starter opens the picker on Starter", () => {
    vi.useFakeTimers();
    try {
      render(
        <CreditWallNotice
          wall={{ message: "Instagram needs the Starter plan ($20/mo).", kind: "plan", tier: "starter" }}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "See plans" }));
      vi.advanceTimersByTime(100);
      expect(window.location.hash).toBe("#billing-upgrade-starter-6mo");
    } finally {
      vi.useRealTimers();
      window.location.hash = "";
    }
  });

  it("wallBillingTarget: credits, an unknown tier, or free open plain Billing", () => {
    expect(wallBillingTarget("plan", "pro")).toBe("billing-upgrade-pro-6mo");
    expect(wallBillingTarget("credits", "pro")).toBe("billing");
    expect(wallBillingTarget("plan", null)).toBe("billing");
    expect(wallBillingTarget("plan", "free")).toBe("billing");
    expect(wallBillingTarget("plan", "enterprise")).toBe("billing");
  });
});

describe("the credit wall, in the conversation", () => {
  it("gives an owner the message and a button that opens Settings", () => {
    render(
      <CreditWallNotice
        wall={{ message: "You're out of credits.", kind: "credits" }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "You're out of credits.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Buy Credits" }));
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(openTab.mock.calls[0][0]).toMatchObject({ kind: "settings" });
  });

  it("leaves the composer alone — the question is already in the thread", () => {
    const tab = readFileSync(
      join(process.cwd(), "src/components/workspace/AgentTab.tsx"),
      "utf8",
    );
    const i = tab.indexOf("const handleCreditWall");
    expect(i).toBeGreaterThan(-1);
    const body = tab.slice(i, i + 220);
    expect(body).toContain("setCreditWall(wall)");
    expect(body).not.toContain("setSeed");
  });

  it("promises nothing about the box", () => {
    render(
      <CreditWallNotice
        wall={{ message: "You're out of credits.", kind: "credits" }}
      />,
    );
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("You're out of credits.");
    expect(alert).not.toContain("box below");
  });

  it("puts one action beside the message, not under it", () => {
    render(
      <CreditWallNotice
        wall={{ message: "You're out of credits.", kind: "credits" }}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: "Buy Credits" });
    expect(buttons).toHaveLength(1);
    const button = buttons[0];
    const message = screen.getByText("You're out of credits.");
    expect(button.parentElement).toBe(message.parentElement?.parentElement);
    expect(button.parentElement?.className).toContain("flex-wrap");
    expect(button.className).toContain("shrink-0");
  });

  it("gives a member the owner ask, and no button to dead-end on", () => {
    role = "member";
    render(
      <CreditWallNotice
        wall={{ message: "You're out of credits.", kind: "credits" }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Ask your workspace owner to add credits.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names the plan wall differently — it is not a top-up", () => {
    render(
      <CreditWallNotice
        wall={{ message: "Your plan does not include this agent.", kind: "plan" }}
      />,
    );
    expect(screen.getByRole("button", { name: "See plans" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Buy Credits" })).toBeNull();
  });

  it("tells a member to upgrade, not to top up, on the plan wall", () => {
    role = "member";
    render(
      <CreditWallNotice
        wall={{ message: "Your plan does not include this agent.", kind: "plan" }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Ask your workspace owner to upgrade the plan.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
