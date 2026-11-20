const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const runtimePath = join(__dirname, "../../web/public/zavi-editor-runtime.js");
const outPath = join(__dirname, "../src/services/sites/editor-runtime-source.generated.ts");
const src = readFileSync(runtimePath, "utf-8").replace(/<\/script/gi, "<\\/script");
writeFileSync(outPath, "export const EDITOR_RUNTIME_SOURCE: string = " + JSON.stringify(src) + ";\n");
console.log("wrote editor-runtime-source.generated.ts (" + src.length + " chars)");
