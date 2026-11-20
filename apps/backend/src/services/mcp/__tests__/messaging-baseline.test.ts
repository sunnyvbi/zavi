
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listSlackTools } from "../internal/slack";
import {
  MESSAGING_BASELINE,
  withMessagingBaseline,
  isMessagingBaselineTool,
} from "../write-allowlist";

describe("MESSAGING_BASELINE — drift guard", () => {
  it("(a) every messaging-baseline tool exists in the slack facade (no unreachable tool)", () => {
    const facade = new Set(
      listSlackTools().map((t) => `${t.server_id}__${t.tool_name}`),
    );
    const missing = [...MESSAGING_BASELINE].filter((t) => !facade.has(t));
    expect(missing).toEqual([]);
  });

  it("(b) grants all 4 when slack connected, none when not (connector-gated)", () => {
    const base = ["web_search__search"];
    const connected = withMessagingBaseline(base, true);
    for (const t of MESSAGING_BASELINE) expect(connected).toContain(t);

    const disconnected = withMessagingBaseline(base, false);
    for (const t of MESSAGING_BASELINE) expect(disconnected).not.toContain(t);
    expect(disconnected).toEqual(base);
  });

  it("(b2) is dedup-safe + order-stable (declared tools first)", () => {
    const declared = ["slack__post_message", "web_search__search"];
    const out = withMessagingBaseline(declared, true);
    expect(out.slice(0, 2)).toEqual(declared);
    expect(out.filter((t) => t === "slack__post_message")).toHaveLength(1);
  });

  it("isMessagingBaselineTool recognizes the full Slack surface (read + send)", () => {
    expect(isMessagingBaselineTool("slack__post_message")).toBe(true);
    expect(isMessagingBaselineTool("slack__open_dm")).toBe(true);
    expect(isMessagingBaselineTool("slack__upload_file")).toBe(true);
    expect(isMessagingBaselineTool("slack__search_users")).toBe(true);
    expect(isMessagingBaselineTool("slack__list_channels")).toBe(true);
    expect(isMessagingBaselineTool("slack__get_channel_history")).toBe(true);
    expect(isMessagingBaselineTool("slack__get_reactions")).toBe(true);
    expect(isMessagingBaselineTool("web_search__search")).toBe(false);
  });

  it("(c) NO agent.md frontmatter re-declares ANY Slack baseline tool", () => {
    const agentsDir = join(__dirname, "../../../agents");
    const offenders: string[] = [];
    for (const ent of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      let md: string;
      try {
        md = readFileSync(join(agentsDir, ent.name, "agent.md"), "utf8");
      } catch {
        continue;
      }
      const re = /^\s*-\s+slack__[a-z_]+\s*$/m;
      if (re.test(md)) offenders.push(ent.name);
    }
    expect(offenders).toEqual([]);
  });
});
