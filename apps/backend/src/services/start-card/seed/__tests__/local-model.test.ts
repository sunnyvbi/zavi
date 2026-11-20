import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { claudeCli, cliArgs, cliEnv, envelopeText } from "../local-model";

describe("local model (claude -p)", () => {
  it("runs isolated: no settings, MCP, tools, slash commands or saved session", () => {
    const a = cliArgs("claude-haiku-5-5", "SYS", "USER");
    for (const f of ["-p", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) expect(a).toContain(f);
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("");
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--system-prompt") + 1]).toBe("SYS");
    expect(a.at(-1)).toBe("USER");
  });
  it("passes no API, database or vendor keys to the CLI", () => {
    const env = cliEnv({ HOME: "/h", PATH: "/p", USER: "u", LANG: "en", ANTHROPIC_API_KEY: "k", SUPABASE_SERVICE_ROLE_KEY: "s", DATAFORSEO_PASSWORD: "d" });
    expect(env).toEqual({ HOME: "/h", PATH: "/p", USER: "u", LANG: "en" });
  });
  it("reads the model text from the envelope and refuses an error envelope", () => {
    expect(envelopeText('{"type":"result","is_error":false,"result":"{\\"a\\":1}"}')).toBe('{"a":1}');
    expect(() => envelopeText('{"is_error":true,"subtype":"error_max_turns"}')).toThrow(/claude_cli_error/);
    expect(() => envelopeText("not json")).toThrow(/bad_envelope/);
  });
  it("calls from an empty temp dir that is removed afterwards", async () => {
    let seenCwd = "";
    const cli = claudeCli({
      runCli: async (args, o) => {
        seenCwd = o.cwd;
        expect(existsSync(o.cwd)).toBe(true);
        expect(o.env.ANTHROPIC_API_KEY).toBeUndefined();
        return JSON.stringify({ is_error: false, result: `got ${args.at(-1)}` });
      },
    });
    expect(await cli.complete("s", "hello")).toBe("got hello");
    expect(await cli.enrichment({ system: "s", user: "x", maxTokens: 10, timeoutMs: 1 })).toBe("got x");
    expect(existsSync(seenCwd)).toBe(false);
  });
});
