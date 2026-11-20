import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { ComposioAppTile, catalogVisible, type ComposioToolkit } from "../ComposioApps";
import { visibleConnectedRows } from "@/components/workspace/settings/ConnectedApps";

const t = (o: Partial<ComposioToolkit>): ComposioToolkit => ({ slug: "acme", name: "Acme", logo: "l", category: null, connectable: false, ...o });
const noop = () => {};
const tile = (toolkit: ComposioToolkit, requested = false, connected = false) =>
  renderToString(
    <ComposioAppTile toolkit={toolkit} connected={connected} requested={requested} busy={false} readOnly={false}
      onConnect={noop} onDisconnect={noop} onRequest={noop} />,
  );

describe("ComposioAppTile states", () => {
  it("connectable → Connect", () => {
    const h = tile(t({ connectable: true }));
    expect(h).toContain("Connect");
    expect(h).not.toContain("I need it");
  });
  it("not connectable → Coming soon + I need it", () => {
    const h = tile(t({}));
    expect(h).toContain("Coming soon");
    expect(h).toContain("I need it");
  });
  it("requested → Requested + thanks note", () => {
    const h = tile(t({}), true);
    expect(h).toContain("Requested");
    expect(h).toContain("Thanks, we&#x27;ll let you know when it&#x27;s ready");
    expect(h).not.toContain("I need it");
  });
  it("connected → Manage menu", () => {
    const h = tile(t({ connectable: true }), false, true);
    expect(h).toContain("Manage");
    expect(h).toContain("Connected");
  });
});

describe("catalogVisible", () => {
  it("hides connected apps and filters by query", () => {
    const list = [t({ slug: "a", name: "Alpha" }), t({ slug: "b", name: "Beta" })];
    expect(catalogVisible(list, new Set(["a"]), "").map((x) => x.slug)).toEqual(["b"]);
    expect(catalogVisible(list, new Set(), "alp").map((x) => x.slug)).toEqual(["a"]);
  });
});

describe("visibleConnectedRows", () => {
  it("drops pipedream rows and native-rail composio rows (spec 14), keeps Composio-rail and native rows", () => {
    const rows = ["pipedream.gmail", "composio.notion", "composio.linear", "composio.instagram", "linear"].map((slug) => ({ slug }));
    expect(visibleConnectedRows(rows).map((r) => r.slug)).toEqual(["composio.notion", "composio.instagram", "linear"]);
  });
});
