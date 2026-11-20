import { describe, it, expect } from "vitest";
import { parseFile, grammarForFile } from "../parse-ts";

const SWIFT = `import SwiftUI

struct CarView: View {
  let id: Int
  var title: String
  func render() -> String { return greet(title) }
}

class Manager {
  func go() { render() }
}

enum CarState { case idle, running }

protocol Drawable { func draw() }

extension CarView { func helper() {} }

func topLevel() {}
`;

const KOTLIN = `package com.upcar

class Manager(val id: Int) {
  fun go(): String = compute()
  val name: String = "y"
}

object Singleton { fun setup() {} }

interface Drawable { fun draw() }

enum class CarState { IDLE, RUNNING }

fun topLevel() {}
`;

function byName(symbols: Array<{ symbol_name: string; kind: string }>) {
  const m = new Map<string, string>();
  for (const s of symbols) m.set(s.symbol_name, s.kind);
  return m;
}

describe("parseFile — Swift", () => {
  it("extracts struct/class/enum/protocol/extension/func/property symbols with the right kinds", async () => {
    const { symbols } = await parseFile("App/CarView.swift", SWIFT);
    const k = byName(symbols);
    expect(k.get("Manager")).toBe("class");
    expect(k.get("CarState")).toBe("enum");
    expect(k.get("Drawable")).toBe("protocol");
    expect(k.get("render")).toBe("function");
    expect(k.get("go")).toBe("function");
    expect(k.get("topLevel")).toBe("function");
    expect(k.get("id")).toBe("const");
    expect(k.get("title")).toBe("var");
    const carViewKinds = symbols
      .filter((s) => s.symbol_name === "CarView")
      .map((s) => s.kind);
    expect(carViewKinds).toContain("struct");
    expect(carViewKinds).toContain("extension");
  });

  it("extracts call references (code_callers signal)", async () => {
    const { refs } = await parseFile("App/CarView.swift", SWIFT);
    const calls = refs.filter((r) => r.ref_kind === "call").map((r) => r.symbol_name);
    expect(calls).toContain("greet");
    expect(calls).toContain("render");
  });
});

describe("parseFile — Kotlin", () => {
  it("extracts class/interface/object/fun/property symbols with the right kinds", async () => {
    const { symbols } = await parseFile("app/Manager.kt", KOTLIN);
    const k = byName(symbols);
    expect(k.get("Manager")).toBe("class");
    expect(k.get("Singleton")).toBe("object");
    expect(k.get("Drawable")).toBe("interface");
    expect(k.get("CarState")).toBe("enum");
    expect(k.get("go")).toBe("function");
    expect(k.get("setup")).toBe("function");
    expect(k.get("topLevel")).toBe("function");
    expect(k.get("name")).toBe("const");
  });

  it("extracts call references", async () => {
    const { refs } = await parseFile("app/Manager.kt", KOTLIN);
    const calls = refs.filter((r) => r.ref_kind === "call").map((r) => r.symbol_name);
    expect(calls).toContain("compute");
  });
});

describe("grammarForFile — extension routing", () => {
  it("routes .swift / .kt / .kts to the right grammar; leaves TS untouched", () => {
    expect(grammarForFile("a/b.swift")).toBe("swift");
    expect(grammarForFile("a/b.kt")).toBe("kotlin");
    expect(grammarForFile("a/b.kts")).toBe("kotlin");
    expect(grammarForFile("a/b.ts")).toBe("typescript");
    expect(grammarForFile("a/b.tsx")).toBe("tsx");
    expect(grammarForFile("a/b.md")).toBeNull();
  });
});

describe("parseFile — TS regression (walker dispatch must not break TS)", () => {
  it("still extracts TS symbols via the TS walker", async () => {
    const { symbols } = await parseFile(
      "src/x.ts",
      "export function foo() {}\nexport class Bar {}\nexport const baz = 1;\n",
    );
    const k = byName(symbols);
    expect(k.get("foo")).toBe("function");
    expect(k.get("Bar")).toBe("class");
    expect(k.get("baz")).toBe("const");
  });
});
