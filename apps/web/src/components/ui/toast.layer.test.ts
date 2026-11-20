import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const toast = readFileSync(join(__dirname, "toast.tsx"), "utf8");
const drawer = readFileSync(
  join(__dirname, "../workspace/layout/WorkspaceDrawer.tsx"),
  "utf8",
);
const nav = readFileSync(
  join(__dirname, "../workspace/layout/CompactNavOverlay.tsx"),
  "utf8",
);

function layerOf(source: string, marker: RegExp) {
  const match = marker.exec(source);
  if (!match) throw new Error(`no z-index in ${marker}`);
  return Number(match[1]);
}

describe("the toast viewport", () => {
  it("sits above the nav sheet and the workspace drawer", () => {
    const toastLayer = layerOf(
      toast,
      /pointer-events-none fixed z-\[?(\d+)\]?/,
    );
    const drawerLayer = layerOf(drawer, /z-\[(\d+)\]/);
    const navLayer = layerOf(nav, /fixed inset-0 z-\[?(\d+)\]?/);
    expect(toastLayer).toBeGreaterThan(drawerLayer);
    expect(toastLayer).toBeGreaterThan(navLayer);
  });
});
