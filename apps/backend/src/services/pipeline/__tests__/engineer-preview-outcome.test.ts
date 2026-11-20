import { describe, it, expect } from "vitest";
import {
  evaluateEngineerPreviewOutcome,
  evaluateProbeResponse,
  probeEngineerPreviewPath,
} from "../preview-probe";

const E2B = "https://3000-abc123.e2b.app";

describe("evaluateEngineerPreviewOutcome — fails closed", () => {
  it("on_target ONLY when a diff-derived marker is present in the body", () => {
    expect(
      evaluateEngineerPreviewOutcome({
        status: 200,
        body: "<html><h2>Pending</h2></html>",
        markers: ["Pending", "Upcoming"],
      }),
    ).toEqual({ outcome: "on_target", reason: null, http_status: 200 });
  });

  it("ANY marker hit is enough — a client-only string may not reach the SSR body", () => {
    expect(
      evaluateEngineerPreviewOutcome({
        status: 200,
        body: "<html><h2>History</h2></html>",
        markers: ["Pending", "Upcoming", "History"],
      }).outcome,
    ).toBe("on_target");
  });

  it("200 with markers present-but-absent-from-body is off_target/no_marker", () => {
    expect(
      evaluateEngineerPreviewOutcome({
        status: 200,
        body: "<html><h1>Tutors from India.</h1></html>",
        markers: ["Pending", "Upcoming"],
      }),
    ).toEqual({ outcome: "off_target", reason: "no_marker", http_status: 200 });
  });

  it("200 with NO markers to check is off_target — a status code proves nothing", () => {
    expect(
      evaluateEngineerPreviewOutcome({ status: 200, body: "<html>anything</html>", markers: [] }),
    ).toEqual({ outcome: "off_target", reason: "no_marker", http_status: 200 });
  });

  it("a redirect is off_target/auth_or_redirect — the app is refusing an anonymous visitor", () => {
    for (const status of [301, 302, 303, 307, 308]) {
      expect(evaluateEngineerPreviewOutcome({ status, body: "", markers: ["X"] })).toEqual({
        outcome: "off_target",
        reason: "auth_or_redirect",
        http_status: status,
      });
    }
  });

  it("4xx/5xx is off_target/route_error", () => {
    for (const status of [404, 401, 403, 500, 502]) {
      expect(evaluateEngineerPreviewOutcome({ status, body: "", markers: ["X"] }).reason).toBe(
        "route_error",
      );
    }
  });

  it("ignores blank/whitespace markers rather than treating them as a free pass", () => {
    expect(
      evaluateEngineerPreviewOutcome({ status: 200, body: "<html>x</html>", markers: ["", "   "] }),
    ).toEqual({ outcome: "off_target", reason: "no_marker", http_status: 200 });
  });
});

describe("evaluateProbeResponse (C1.5 gate) — semantics preserved", () => {
  it("still treats 3xx as PASS (NOT auth_or_redirect)", () => {
    expect(evaluateProbeResponse({ status: 302, body: "" }).verdict).toBe("pass");
  });
  it("still fails on 5xx", () => {
    expect(evaluateProbeResponse({ status: 500, body: "" }).verdict).toBe("fail");
  });
  it("still skips on an unexpected 4xx (non-blocking)", () => {
    expect(evaluateProbeResponse({ status: 404, body: "" }).verdict).toBe("skipped");
  });
  it("still passes a 200 with NO markers (liveness-only)", () => {
    expect(evaluateProbeResponse({ status: 200, body: "x" }).verdict).toBe("pass");
  });
});

describe("probeEngineerPreviewPath — never leaves the preview origin", () => {
  it("fetches the deep-linked path on the preview origin", async () => {
    let fetched = "";
    const v = await probeEngineerPreviewPath({
      preview_url: E2B,
      preview_path: "/tutor/bookings",
      markers: ["Pending"],
      fetchPath: async (url) => {
        fetched = url;
        return { ok: true, status: 200, body: "<h2>Pending</h2>" };
      },
    });
    expect(fetched).toBe(`${E2B}/tutor/bookings`);
    expect(v.outcome).toBe("on_target");
  });

  it("rejects a non-e2b origin without fetching (no SSRF)", async () => {
    let called = false;
    const v = await probeEngineerPreviewPath({
      preview_url: "https://evil.com",
      preview_path: "/x",
      markers: ["X"],
      fetchPath: async () => {
        called = true;
        return { ok: true, status: 200, body: "X" };
      },
    });
    expect(called).toBe(false);
    expect(v).toEqual({ outcome: "off_target", reason: "route_error", http_status: null });
  });

  it("an unreachable preview degrades to off_target, never a throw", async () => {
    const v = await probeEngineerPreviewPath({
      preview_url: E2B,
      preview_path: "/x",
      markers: ["X"],
      fetchPath: async () => ({ ok: false, error: "timeout" }),
    });
    expect(v).toEqual({ outcome: "off_target", reason: "route_error", http_status: null });
  });

  it("a throwing fetcher degrades to off_target, never a throw", async () => {
    await expect(
      probeEngineerPreviewPath({
        preview_url: E2B,
        preview_path: "/x",
        markers: ["X"],
        fetchPath: async () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toEqual({ outcome: "off_target", reason: "route_error", http_status: null });
  });
});
