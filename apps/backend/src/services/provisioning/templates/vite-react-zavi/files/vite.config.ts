import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { validateManifest } from "./src/zavi/manifest";
import manifest from "./zavi-site.json";
import { zaviHead } from "./vite-zavi-head";
import pages from "./zavi-pages.json";
import { zaviSeo } from "./vite-zavi-seo";

function zaviManifest(): Plugin {
  return {
    name: "zavi-manifest",
    buildStart() {
      const res = validateManifest(manifest);
      if (!res.ok) this.error("zavi-site.json is invalid:\n" + res.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n"));
    },
  };
}

const ZAVI_HEAD = { name: "", url: "", image: "" };

export default defineConfig({
  plugins: [react(), zaviManifest(), zaviHead(ZAVI_HEAD, pages), zaviSeo(ZAVI_HEAD)],
  resolve: { alias: { "@": decodeURIComponent(new URL("./src", import.meta.url).pathname) } },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: [".e2b.app"],
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
  },
});
