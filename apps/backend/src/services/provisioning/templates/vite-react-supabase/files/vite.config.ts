import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { zaviHead } from "./vite-zavi-head";
import pages from "./zavi-pages.json";
import { zaviSeo } from "./vite-zavi-seo";

const ZAVI_HEAD = { name: "", url: "", image: "" };

export default defineConfig({
  plugins: [react(), zaviHead(ZAVI_HEAD, pages), zaviSeo(ZAVI_HEAD)],
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
