import { envFlagOn } from "@/services/config/env-flag";

export function managedLinkedinEnabled(): boolean {
  return (
    envFlagOn(process.env.ADS_LINKEDIN_MANAGED_ENABLED) &&
    process.env.ADS_LINKEDIN_ROLLOUT_ACK === "campaign-bindings-forward-only"
  );
}
