import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { waitingClause, waitingLabel, WAITING_DISPLAY_CAP } from "./ChannelsPage";

describe("waitingClause — the count a locked tile appends", () => {
  it("names the work waiting behind the lock", () => {
    expect(`Coming soon${waitingClause(4)}`).toBe("Coming soon · 4 waiting");
  });

  it("caps at the number the list shows, so the tile cannot outrun it", () => {
    expect(`Coming soon${waitingClause(17)}`).toBe("Coming soon · 5+ waiting");
  });

  it("says nothing when nothing is waiting, rather than '0 waiting'", () => {
    expect(`Coming soon${waitingClause(0)}`).toBe("Coming soon");
  });

  it("reads as one action, not one waitings", () => {
    expect(`Coming soon${waitingClause(1)}`).toBe("Coming soon · 1 waiting");
  });

  it("takes a spoken separator for the rail's aria-label", () => {
    expect(`coming soon${waitingClause(4, ", ")}`).toBe("coming soon, 4 waiting");
  });
});

describe("waitingLabel — the cap the panel list already obeys", () => {
  it("prints a real count under the cap", () => {
    expect(waitingLabel(0)).toBe("0");
    expect(waitingLabel(1)).toBe("1");
    expect(waitingLabel(WAITING_DISPLAY_CAP)).toBe("5");
  });

  it("marks anything over the cap, rather than claiming the backlog is five", () => {
    expect(waitingLabel(WAITING_DISPLAY_CAP + 1)).toBe("5+");
    expect(waitingLabel(12)).toBe("5+");
  });
});

describe("every tile variant renders through the cap", () => {
  const FILES = ["ChannelsPage.tsx", "ChannelsPanel.tsx"];

  const RAW_IN_JSX = /\{\s*(?:entry\.)?waiting\s*\}/g;

  it.each(FILES)("%s never renders a bare count", (file) => {
    const src = readFileSync(join(__dirname, file), "utf8");
    expect(src.match(RAW_IN_JSX)).toBeNull();
  });
});
