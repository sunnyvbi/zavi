
import { seedTenantChannels } from "./seed-channels";
import { seedOrchestratorSchedules } from "./seed-schedules";

export type SeedTenantBootstrapResult = {
  channels_inserted: number;
  schedules_inserted: number;
  errors: string[];
};

export async function seedTenantBootstrap(
  tenant_id: string,
): Promise<SeedTenantBootstrapResult> {
  const errors: string[] = [];
  let channels_inserted = 0;
  let schedules_inserted = 0;

  try {
    const res = await seedTenantChannels(tenant_id);
    channels_inserted = res.channels_inserted;
    if (res.error) errors.push(`seedTenantChannels: ${res.error}`);
  } catch (e) {
    errors.push(`seedTenantChannels: ${(e as Error).message}`);
  }

  try {
    const r = await seedOrchestratorSchedules(tenant_id);
    schedules_inserted = r.inserted;
  } catch (e) {
    const msg = `seedOrchestratorSchedules failed for ${tenant_id}: ${(e as Error).message}`;
    console.warn(`[bootstrap] ${msg}`);
    errors.push(msg);
  }

  return { channels_inserted, schedules_inserted, errors };
}
