const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function loadTs(file, stubs = {}, cache = new Map()) {
  const abs = path.resolve(file);
  if (cache.has(abs)) return cache.get(abs).exports;
  const source = fs.readFileSync(abs, "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: abs,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
  const mod = { exports: {} };
  cache.set(abs, mod);
  const req = (spec) => {
    if (Object.prototype.hasOwnProperty.call(stubs, spec)) return stubs[spec];
    if (spec.startsWith(".")) {
      const base = path.resolve(path.dirname(abs), spec);
      const found = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((p) => fs.existsSync(p));
      if (found) return loadTs(found, stubs, cache);
    }
    throw new Error(`load-ts: no stub for "${spec}" (from ${path.basename(abs)})`);
  };
  vm.runInNewContext(compiled, {
    module: mod,
    exports: mod.exports,
    require: req,
    React: stubs.react,
    Intl,
    Date,
    Math,
    JSON,
    Number,
    Set,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
    console,
    URL,
    URLSearchParams,
    Error,
    TypeError,
    Uint8Array,
    globalThis,
  });
  return mod.exports;
}

module.exports = { loadTs };
