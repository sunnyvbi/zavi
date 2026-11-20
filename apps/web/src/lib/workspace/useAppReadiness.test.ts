import { describe, expect, it } from "vitest";
import { readinessKey } from "./useAppReadiness";

describe("readinessKey", () => {
  it("gates our app hosts and the sandbox dev-server preview hosts by origin", () => {
    expect(readinessKey("https://x-1.onrender.com/a?b=1")).toBe("https://x-1.onrender.com");
    expect(readinessKey("https://site-1.zaviagent.com/")).toBe("https://site-1.zaviagent.com");
    expect(readinessKey("https://5173-ic74qfgbv8ttud2gphnbi.e2b.app/")).toBe("https://5173-ic74qfgbv8ttud2gphnbi.e2b.app");
    expect(readinessKey("https://3000-abc123def.e2b.dev/x")).toBe("https://3000-abc123def.e2b.dev");
  });

  it("does not gate other hosts, http, or lookalikes", () => {
    expect(readinessKey("https://preview-proxy.example.com/run/1")).toBeNull();
    expect(readinessKey("http://5173-abc.e2b.app/")).toBeNull();
    expect(readinessKey("https://5173-abc.e2b.app.evil.example/")).toBeNull();
    expect(readinessKey(null)).toBeNull();
  });
});
