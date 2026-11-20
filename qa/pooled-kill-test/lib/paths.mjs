import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SRC = resolve(process.env.ZAVI_POOLED_SRC || resolve(KIT, "../.."));
export const STARTER = `${SRC}/apps/backend/src/services/provisioning/templates/vite-react-zavi/files`;
export const SDK_DIR = `${STARTER}/src/zavi`;
export const MANIFEST_PKG = `${SRC}/packages/site-manifest/src/index.ts`;

export function assertSource() {
  for (const p of [`${SDK_DIR}/client.ts`, `${SDK_DIR}/devstore.ts`, `${SDK_DIR}/local.ts`, MANIFEST_PKG]) {
    if (!existsSync(p)) {
      throw new Error(`pooled-backend source not found: ${p}\nSet ZAVI_POOLED_SRC to a checkout of integration/pooled-site-db (or of main once it has merged).`);
    }
  }
}

export async function loadReal() {
  assertSource();
  const [client, devstore, local, manifest] = await Promise.all([
    import(`${SDK_DIR}/client.ts`),
    import(`${SDK_DIR}/devstore.ts`),
    import(`${SDK_DIR}/local.ts`),
    import(MANIFEST_PKG),
  ]);
  return { manifestPkg: manifest, createZavi: client.createZavi, ZaviError: (await import(`${SDK_DIR}/errors.ts`)).ZaviError, DevStore: devstore.DevStore, createLocalServer: local.createLocalServer, validateManifest: manifest.validateManifest };
}

export function validatorSupportsV2(validateManifest) {
  const probe = { schemaVersion: 2, roles: [], capabilities: [], actions: {}, aggregates: {}, collections: { x: { kind: "records", rules: { list: ["admin"], get: ["admin"], create: ["admin"], update: ["admin"], delete: ["admin"] }, schema: { type: "object", properties: { a: { type: "string", maxLength: 5 } }, required: [] }, fields: {}, indexes: {}, unique: [], references: {} } } };
  try { return validateManifest(probe).ok === true; } catch { return false; }
}
