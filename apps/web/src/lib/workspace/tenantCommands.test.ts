
import { describe, it, expect } from "vitest";
import {
  filterTenantCommands,
  matchTenantInvocation,
  tenantCommandHint,
  type TenantCommand,
} from "./tenantCommands";
import { SLASH_COMMANDS } from "./slashCommandRegistry";

const RESERVED_DB = ["feedback", "clear", "help", "run", "decision"] as const;

function makeCmd(slug: string): TenantCommand {
  return {
    id: slug,
    slug,
    name: slug,
    description: "",
    instructions_md: "",
    updated_at: "2026-05-17T00:00:00Z",
  };
}

type Case = { name: string; assert: () => string | null };

const cases: Case[] = [
  {
    name: "filterTenantCommands: empty query → full list",
    assert: () => {
      const rows = [makeCmd("alpha"), makeCmd("beta")];
      const got = filterTenantCommands("", rows);
      return got.length === 2 ? null : `expected 2, got ${got.length}`;
    },
  },
  {
    name: "filterTenantCommands: prefix narrows match",
    assert: () => {
      const rows = [makeCmd("onboard-host"), makeCmd("refund"), makeCmd("ops")];
      const got = filterTenantCommands("on", rows);
      const slugs = got.map((c) => c.slug).join(",");
      return slugs === "onboard-host" ? null : `expected onboard-host, got ${slugs}`;
    },
  },
  {
    name: "filterTenantCommands: case-insensitive",
    assert: () => {
      const rows = [makeCmd("onboard-host")];
      const got = filterTenantCommands("ON", rows);
      return got.length === 1 ? null : `expected case-insensitive match`;
    },
  },

  {
    name: "matchTenantInvocation: /foo my body → {slug:foo, body:'my body'}",
    assert: () => {
      const got = matchTenantInvocation("/foo my body here");
      if (!got) return "expected match";
      if (got.slug !== "foo") return `slug=${got.slug}`;
      if (got.body !== "my body here") return `body=${got.body}`;
      return null;
    },
  },
  {
    name: "matchTenantInvocation: /foo (no body) → {slug:foo, body:''}",
    assert: () => {
      const got = matchTenantInvocation("/foo");
      if (!got) return "expected match";
      return got.slug === "foo" && got.body === ""
        ? null
        : `unexpected ${JSON.stringify(got)}`;
    },
  },
  {
    name: "matchTenantInvocation: /foo-bar body → {slug:foo-bar} (NOT slug=foo + body='-bar ...')",
    assert: () => {
      const got = matchTenantInvocation("/foo-bar body here");
      if (!got) return "expected match";
      return got.slug === "foo-bar" ? null : `wrong-prefix-match slug=${got.slug}`;
    },
  },
  {
    name: "matchTenantInvocation: no leading slash → null",
    assert: () => {
      return matchTenantInvocation("hello world") === null ? null : "should not match";
    },
  },
  {
    name: "matchTenantInvocation: uppercase slug → null (regex is lowercase-only)",
    assert: () => {
      return matchTenantInvocation("/FOO body") === null
        ? null
        : "uppercase slug should not match";
    },
  },
  {
    name: "matchTenantInvocation: slug starting with digit → null",
    assert: () => {
      return matchTenantInvocation("/9cmd body") === null
        ? null
        : "slug must start with letter";
    },
  },

  {
    name: "DB reserved-slug list == SLASH_COMMANDS.map(c=>c.name)",
    assert: () => {
      const built = SLASH_COMMANDS.map((c) => c.name).sort();
      const reserved = [...RESERVED_DB].sort();
      const a = JSON.stringify(built);
      const b = JSON.stringify(reserved);
      return a === b
        ? null
        : `drift!\n      builtin: ${a}\n      DB reserved: ${b}\n      → update both lists when adding a new built-in slash command`;
    },
  },
];

export function runTenantCommandsTests(): {
  pass: number;
  fail: number;
  failures: string[];
} {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];
  for (const c of cases) {
    const err = c.assert();
    if (err === null) pass += 1;
    else {
      fail += 1;
      failures.push(`  - ${c.name}\n      ${err}`);
    }
  }
  return { pass, fail, failures };
}

describe("tenantCommandHint", () => {
  const cmds: TenantCommand[] = [makeCmd("test-command"), makeCmd("onboard-host")];

  it("not loaded → null (never mislabel a maybe-valid command mid-load)", () => {
    expect(tenantCommandHint("/test-command hi", cmds, false, false)).toBeNull();
  });

  it("fetch error → null (can't assert unknown when the list didn't load)", () => {
    expect(tenantCommandHint("/test-command hi", [], true, true)).toBeNull();
  });

  it("loaded + known + body → run hint", () => {
    expect(tenantCommandHint("/test-command hi", cmds, true, false)).toBe(
      "⏎ to run /test-command.",
    );
  });

  it("loaded + known + empty body → needs-a-message (matches send guard)", () => {
    expect(tenantCommandHint("/test-command", cmds, true, false)).toBe(
      "/test-command needs a message.",
    );
  });

  it("loaded + unknown slug → generic Unknown-command copy", () => {
    const hint = tenantCommandHint("/nope hi", cmds, true, false);
    expect(hint).toContain("Unknown command");
  });

  it("prefix safety: /test does NOT match /test-command", () => {
    const hint = tenantCommandHint("/test hi", cmds, true, false);
    expect(hint).toContain("Unknown command");
  });

  it("non-slash input → generic Unknown-command copy", () => {
    expect(tenantCommandHint("hello", cmds, true, false)).toContain(
      "Unknown command",
    );
  });
});
