
import {
  SITE_MANIFEST_PATH,
  STARTER_SQL_PATH,
  type SiteStarterProvider,
  type StarterFiles,
} from "@/services/sites/contract";
import { TEMPLATE_FILES } from "./template-files.generated";

export const VITE_STARTER_LOCKFILE_SCRIPT = "scripts/generate-vite-starter-lockfile.ts";

export function createViteStarterProvider(files: Readonly<Record<string, string>>): SiteStarterProvider {
  return {
    starterFiles(): StarterFiles {
      if (!files["package-lock.json"]) {
        throw new Error(`vite starter has no package-lock.json; run ${VITE_STARTER_LOCKFILE_SCRIPT} (e2b) first`);
      }
      const starterSql = files[STARTER_SQL_PATH];
      const manifest = files[SITE_MANIFEST_PATH];
      if (!starterSql || !manifest) throw new Error("vite starter is missing starter.sql or zavi-site.json");
      return { files: { ...files }, starter_sql: starterSql, manifest_json: manifest };
    },
  };
}

export const viteStarterProvider: SiteStarterProvider = createViteStarterProvider(TEMPLATE_FILES);
