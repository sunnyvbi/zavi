
import { E2B_ZAVI_TEMPLATE_ALIAS, SITE_MANIFEST_PATH, type SiteStarterProvider, type StarterFiles } from "@/services/sites/contract";
import { TEMPLATE_FILES } from "./template-files.generated";

export const ZAVI_STARTER_ID = "vite-react-zavi";
export const STARTER_PLACEHOLDER_HOME_PATH = "src/pages/Home.tsx";
export { E2B_ZAVI_TEMPLATE_ALIAS };
export const ZAVI_STARTER_LOCKFILE_COMMAND = "npx tsx scripts/build-e2b-zavi-template.ts lockfile";
export const ZAVI_STARTER_BUILD_COMMAND = "npx tsx scripts/build-e2b-zavi-template.ts build";

export function createZaviStarterProvider(files: Readonly<Record<string, string>>): SiteStarterProvider {
  return {
    starterFiles(): StarterFiles {
      if (!files["package-lock.json"]) {
        throw new Error(`vite-react-zavi starter has no package-lock.json; run ${ZAVI_STARTER_LOCKFILE_COMMAND} (e2b) first`);
      }
      const manifest = files[SITE_MANIFEST_PATH];
      if (!manifest) throw new Error("vite-react-zavi starter is missing zavi-site.json");
      return { files: { ...files }, starter_sql: "", manifest_json: manifest };
    },
  };
}

export const zaviStarterProvider: SiteStarterProvider = createZaviStarterProvider(TEMPLATE_FILES);
