import { describe, expect, it } from "vitest";
import { bindingKey } from "../gateway-kv";

describe("gateway KV key", () => {
  it("keys by lowercase IDNA hostname without port", () => {
    expect(bindingKey("Shop-AB12.zaviagent.com:8443")).toBe("host:shop-ab12.zaviagent.com");
    expect(bindingKey("bücher.example.com")).toBe("host:xn--bcher-kva.example.com");
    expect(() => bindingKey("evil host/x")).toThrow();
    expect(() => bindingKey("localhost")).toThrow();
  });
});
