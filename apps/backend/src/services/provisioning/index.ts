
import { registerProvisioner } from "./registry";
import { createGitHubRepoProvisioner } from "./github-repo";
import { createRenderHostingProvisioner } from "./render-hosting";
import { createNeonDbProvisioner } from "./neon-db";
import { createSendgridEmailProvisioner } from "./sendgrid-email";
import { createDomainProvisioner } from "./domain";
import { createStripeConnectProvisioner } from "./stripe-connect";
import { createMetaAdsProvisioner } from "./ads-meta";

export function registerBuiltinProvisioners(): void {
  registerProvisioner(createGitHubRepoProvisioner());
  registerProvisioner(createRenderHostingProvisioner());
  registerProvisioner(createNeonDbProvisioner());
  registerProvisioner(createSendgridEmailProvisioner());
  registerProvisioner(createDomainProvisioner());
  registerProvisioner(createStripeConnectProvisioner());
  registerProvisioner(createMetaAdsProvisioner());
}

export { getProvisioner, listProvisioners, registerProvisioner } from "./registry";
export { resolveResourceCreds } from "./resolve-creds";
export { resolveResources, type ResolveSummary } from "./resolve-resources";
export { setResourceSecret } from "./secret";
export { provisionCompany, ALL_RESOURCE_KINDS } from "./provision-company";
export { seedTemplate, type SeedTemplateResult, type SeedTemplateDeps } from "./seed-template";
export {
  seedProvisionedRepo,
  isSeedTemplateEnabled,
  type SeedProvisionedRepoResult,
  type SeedProvisionedRepoOpts,
} from "./seed-provisioned-repo";
export { classifyPrompt, STARTER_CATEGORIES, type StarterCategory } from "./starter-picker";
export { buildStarterFiles } from "./templates/starters";
export type { Provisioner, ResourceKind, ResourceMode, ResourceStatus } from "./types";
