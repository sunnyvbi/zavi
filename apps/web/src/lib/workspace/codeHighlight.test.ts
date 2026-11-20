import { describe, expect, it } from "vitest";
import { HIGHLIGHT_MAX_CHARS, highlightCode, langForPath, languageLabel } from "./codeHighlight";

describe("langForPath", () => {
  it("maps extensions and well-known dotfiles", () => {
    expect(langForPath("src/app.tsx")).toBe("tsx");
    expect(langForPath("server.ts")).toBe("typescript");
    expect(langForPath("package.json")).toBe("json");
    expect(langForPath(".prettierrc")).toBe("json");
    expect(langForPath("styles.css")).toBe("css");
    expect(langForPath("supabase/config.toml")).toBe("toml");
  });
  it("returns null for files it cannot colour", () => {
    expect(langForPath("public/robots.txt")).toBeNull();
    expect(langForPath("Makefile")).toBeNull();
    expect(languageLabel("public/robots.txt")).toBe("Plain Text");
  });
});

describe("highlightCode", () => {
  it("colours TypeScript with VS Code Light+ and Dark+ side by side", async () => {
    const lines = await highlightCode("const a = 1;\nexport {};\n", "src/a.ts");
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(2);
    const keyword = lines![0]!.find((t) => t.content === "const");
    expect(keyword?.light?.toUpperCase()).toBe("#0000FF");
    expect(keyword?.dark?.toUpperCase()).toBe("#569CD6");
    expect(lines![0]!.map((t) => t.content).join("")).toBe("const a = 1;");
  }, 20000);

  it("skips files it has no grammar for", async () => {
    expect(await highlightCode("hello", "notes.txt")).toBeNull();
  });

  it("leaves a 50k-character file as plain text instead of tokenising it on the main thread", async () => {
    expect(HIGHLIGHT_MAX_CHARS).toBeLessThanOrEqual(40_000);
    const big = "const a = 1;\n".repeat(Math.ceil(50_000 / 13));
    expect(big.length).toBeGreaterThan(50_000);
    expect(await highlightCode(big, "big.ts")).toBeNull();
  }, 20000);

  it("skips files too large to colour quickly", async () => {
    expect(await highlightCode("a".repeat(HIGHLIGHT_MAX_CHARS + 1), "big.ts")).toBeNull();
  });
});
