import { describe, it, expect } from "vitest";
import {
  CHAT_SLUGS,
  chatConnectorRows,
  type ChatConnectorMetaRow,
} from "./chatConnectorRows";

describe("chatConnectorRows", () => {
  it("returns every chat connector, in nav order, even with nothing connected", () => {
    const rows = chatConnectorRows([]);
    expect(rows.map((r) => r.slug)).toEqual([...CHAT_SLUGS]);
    expect(rows.every((r) => r.connected === false)).toBe(true);
  });

  it("marks a connector connected on presence alone", () => {
    const list: ChatConnectorMetaRow[] = [
      { slug: "whatsapp", connected_at: "2026-09-03T22:12:32Z" },
    ];
    const rows = chatConnectorRows(list);
    const whatsapp = rows.find((r) => r.slug === "whatsapp")!;
    expect(whatsapp.connected).toBe(true);
    expect(whatsapp.connected_at).toBe("2026-09-03T22:12:32Z");
    expect(rows.find((r) => r.slug === "slack")!.connected).toBe(false);
    expect(rows.find((r) => r.slug === "telegram")!.connected).toBe(false);
    expect(rows.find((r) => r.slug === "discord")!.connected).toBe(false);
  });

  it("carries team_name for the two connectors that have one", () => {
    const rows = chatConnectorRows([
      { slug: "slack", team_name: "Upcar HQ" },
      { slug: "discord", team_name: "Upcar Community" },
    ]);
    expect(rows.find((r) => r.slug === "slack")!.team_name).toBe("Upcar HQ");
    expect(rows.find((r) => r.slug === "discord")!.team_name).toBe(
      "Upcar Community",
    );
  });

  it("normalizes SQL NULL to undefined, not null", () => {
    const rows = chatConnectorRows([
      { slug: "telegram", team_name: null, connected_at: null },
    ]);
    const telegram = rows.find((r) => r.slug === "telegram")!;
    expect(telegram.connected).toBe(true);
    expect(telegram.team_name).toBeUndefined();
    expect(telegram.connected_at).toBeUndefined();
  });

  it("ignores non-chat connectors in the same result set", () => {
    const rows = chatConnectorRows([
      { slug: "github" },
      { slug: "stripe" },
      { slug: "slack", team_name: "Upcar HQ" },
    ]);
    expect(rows).toHaveLength(CHAT_SLUGS.length);
    expect(rows.map((r) => r.slug)).toEqual([...CHAT_SLUGS]);
    expect(rows.find((r) => r.slug === "slack")!.connected).toBe(true);
  });
});
