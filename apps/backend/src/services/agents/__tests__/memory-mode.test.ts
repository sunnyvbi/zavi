import { describe, it, expect } from "vitest";
import {
  memoryOff,
  readMemoryMode,
  stripMemoryToolsIfOff,
} from "../memory-mode";

describe("memoryOff", () => {
  it("is true ONLY for the exact literal 'off'", () => {
    expect(memoryOff({ memory_mode: "off" })).toBe(true);
    expect(memoryOff({ memory_mode: "on" })).toBe(false);
    expect(memoryOff({})).toBe(false);
    expect(memoryOff({ memory_mode: undefined })).toBe(false);
  });
});

describe("readMemoryMode", () => {
  it("returns 'off' only when payload.memory_mode === 'off'", () => {
    expect(readMemoryMode({ memory_mode: "off" })).toBe("off");
  });
  it("returns undefined for anything else (safe default = memory on)", () => {
    expect(readMemoryMode(undefined)).toBeUndefined();
    expect(readMemoryMode(null)).toBeUndefined();
    expect(readMemoryMode("off")).toBeUndefined();
    expect(readMemoryMode({ memory_mode: "on" })).toBeUndefined();
    expect(readMemoryMode({ memory_mode: true })).toBeUndefined();
    expect(readMemoryMode({ memory_mode: "OFF" })).toBeUndefined();
    expect(readMemoryMode({ other: 1 })).toBeUndefined();
  });
});

describe("stripMemoryToolsIfOff", () => {
  const tools = [
    { name: "memory__search" },
    { name: "memory__write" },
    { name: "memory__list_topics" },
    { name: "brain__refine_anchor" },
    { name: "tenant_skill__weekly_report" },
    { name: "slack__post_message" },
    { name: "web_search" },
  ];

  it("drops memory__*, brain__*, AND tenant_skill__* tools when memory is off", () => {
    const out = stripMemoryToolsIfOff(tools, { memory_mode: "off" });
    expect(out.map((t) => t.name)).toEqual(["slack__post_message", "web_search"]);
  });

  it("returns the list untouched (same reference) when memory is on", () => {
    const out = stripMemoryToolsIfOff(tools, {});
    expect(out).toBe(tools);
  });
});
