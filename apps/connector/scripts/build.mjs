import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
  legalComments: "none",
  tsconfig: "tsconfig.json",
  external: Object.keys(pkg.dependencies ?? {}),
  define: { __CONNECTOR_VERSION__: JSON.stringify(process.env.CONNECTOR_VERSION || pkg.version) },
  logLevel: "info",
});
