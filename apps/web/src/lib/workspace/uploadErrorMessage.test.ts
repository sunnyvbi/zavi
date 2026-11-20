import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));

import { uploadErrorMessage } from "./uploadErrorMessage";

describe("uploadErrorMessage", () => {
  it("a thrown fetch TypeError reads as a connection problem, with no size hint", () => {
    const msg = uploadErrorMessage("launch.mp4", 50, {
      kind: "thrown",
      error: new TypeError("Failed to fetch"),
    });
    expect(msg).toBe(
      "Couldn't upload launch.mp4: couldn't reach the server. Check your connection and try again.",
    );
    expect(msg).not.toMatch(/MB/);
  });

  it("a network throw on a file over the proxy cap names the size and the likely cause", () => {
    const msg = uploadErrorMessage("WhatsApp Video.mp4", 50, {
      kind: "thrown",
      error: new TypeError("Failed to fetch"),
      sizeBytes: 12.4 * 1024 * 1024,
    });
    expect(msg).toBe(
      "Couldn't upload WhatsApp Video.mp4 (12 MB): the upload didn't go through. Files over 4 MB can be refused, so try a smaller file or check your connection.",
    );
    expect(msg).not.toContain("couldn't reach the server");
  });

  it("a network throw on a small file still reads as a connection problem", () => {
    const msg = uploadErrorMessage("clip.mp4", 50, {
      kind: "thrown",
      error: new TypeError("Failed to fetch"),
      sizeBytes: 2 * 1024 * 1024,
    });
    expect(msg).toContain("couldn't reach the server");
  });

  it("an HTTP 413 from the proxy does not quote the app's larger cap", () => {
    const msg = uploadErrorMessage("big.mp4", 50, { kind: "http", status: 413, body: "<html>413</html>" });
    expect(msg).toBe("Couldn't upload big.mp4: the server didn't accept a file this large. Try a smaller file.");
  });

  it("a non-network throw is NOT blamed on the connection", () => {
    for (const error of [new Error("JSON parse"), new DOMException("aborted", "AbortError"), "weird"]) {
      expect(uploadErrorMessage("a.pdf", 10, { kind: "thrown", error })).toBe(
        "Couldn't upload a.pdf: upload failed. Try again.",
      );
    }
  });

  it("maps the backend's file_too_large code to the size cap, not raw JSON", () => {
    const msg = uploadErrorMessage("deck.pdf", 10, {
      kind: "http",
      status: 400,
      body: JSON.stringify({ error: { code: "file_too_large", message: "file exceeds 10MB cap" } }),
    });
    expect(msg).toBe("Couldn't upload deck.pdf: the file is too large (max 10MB).");
  });

  it("tells the operator to refresh on 401", () => {
    const msg = uploadErrorMessage("a.csv", 10, {
      kind: "http",
      status: 401,
      body: JSON.stringify({ error: { code: "unauthenticated", message: "Missing or invalid Bearer token." } }),
    });
    expect(msg).toContain("session expired");
  });

  it("explains a content/type mismatch", () => {
    const msg = uploadErrorMessage("fake.mp4", 50, {
      kind: "http",
      status: 400,
      body: JSON.stringify({ error: { code: "invalid_mp4", message: "file content does not appear to be an MP4" } }),
    });
    expect(msg).toContain("doesn't match its type");
  });

  it("falls back to the server message, then to the status", () => {
    expect(
      uploadErrorMessage("a.txt", 10, {
        kind: "http",
        status: 500,
        body: JSON.stringify({ error: { code: "upload_failed", message: "storage down" } }),
      }),
    ).toBe("Couldn't upload a.txt: storage down");
    expect(uploadErrorMessage("a.txt", 10, { kind: "http", status: 502, body: "<html>bad gateway</html>" })).toBe(
      "Couldn't upload a.txt: upload failed (HTTP 502). Try again.",
    );
  });
});
