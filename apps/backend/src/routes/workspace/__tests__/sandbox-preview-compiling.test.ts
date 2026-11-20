import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { probeSandboxPreview, probeSandboxPreviewCached } from "@/routes/workspace/autopilot";

const res = (status: number, body: string) => ({ status, text: async () => body });

describe("probeSandboxPreview", () => {
  it("a Next compile-error page is 'compiling', even when it comes back as a 500", async () => {
    expect(await probeSandboxPreview("u", vi.fn().mockResolvedValue(res(500, '<html id="__next_error__"><body></body></html>')))).toBe("compiling");
    expect(await probeSandboxPreview("u", vi.fn().mockResolvedValue(res(200, '<div id="nextjs__container_errors_label">Build Error</div>')))).toBe("compiling");
  });

  it("an app page that merely says 'Failed to compile' in its own copy is not mistaken for a compile error", async () => {
    expect(await probeSandboxPreview("u", vi.fn().mockResolvedValue(res(200, "<main><h1>Failed to compile? We fix builds.</h1></main>")))).toBe("ok");
  });

  it("a normal page is 'ok' and a plain error or unreachable server is 'dead'", async () => {
    expect(await probeSandboxPreview("u", vi.fn().mockResolvedValue(res(200, "<main>hello</main>")))).toBe("ok");
    expect(await probeSandboxPreview("u", vi.fn().mockResolvedValue(res(307, "")))).toBe("ok");
    expect(await probeSandboxPreview("u", vi.fn().mockResolvedValue(res(502, "Bad gateway")))).toBe("dead");
    expect(await probeSandboxPreview("u", vi.fn().mockRejectedValue(new Error("down")))).toBe("dead");
  });

  it("caches per url for the probe window", async () => {
    const probe = vi.fn().mockResolvedValue("compiling");
    await probeSandboxPreviewCached("https://3000-x.e2b.app", 1_000, probe);
    await probeSandboxPreviewCached("https://3000-x.e2b.app", 2_000, probe);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("build-status keeps a compiling preview instead of killing it", () => {
  const src = readFileSync(join(__dirname, "../autopilot.ts"), "utf-8");
  it("only a 'dead' probe clears the sandbox preview; 'compiling' flags the response", () => {
    expect((src.match(/if \(sandboxState === "dead"\) \{/g) ?? []).length).toBe(2);
    expect((src.match(/if \(sandboxState === "compiling"\) sandboxCompiling = true;/g) ?? []).length).toBe(2);
    expect(src).toMatch(/preview: preview\.kind === "instant" && sandboxCompiling \? \{ \.\.\.preview, compiling: true \} : preview,/);
  });
});
