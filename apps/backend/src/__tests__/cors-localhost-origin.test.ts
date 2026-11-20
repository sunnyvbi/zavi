import { describe, it, expect } from "vitest";
import { isLocalhostDevOrigin } from "../services/cors-origin";

describe("isLocalhostDevOrigin", () => {
  it("allows localhost + 127.0.0.1 on any port and bare", () => {
    for (const o of [
      "http://localhost",
      "http://localhost:3000",
      "http://localhost:8081",
      "http://localhost:8082",
      "http://localhost:19006",
      "http://127.0.0.1",
      "http://127.0.0.1:8082",
    ]) {
      expect(isLocalhostDevOrigin(o), o).toBe(true);
    }
  });

  it("rejects lookalikes, non-http schemes, and other hosts", () => {
    for (const o of [
      "http://localhost.evil.com",
      "http://localhost.evil.com:8082",
      "http://127.0.0.1.evil.com",
      "https://localhost:8082",
      "http://evil.com",
      "http://notlocalhost",
      "http://localhost@evil.com",
      "https://www.zaviagent.com",
      "",
    ]) {
      expect(isLocalhostDevOrigin(o), o).toBe(false);
    }
  });
});
