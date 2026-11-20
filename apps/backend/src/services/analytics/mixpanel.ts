import Mixpanel from "mixpanel";

const INTERNAL_TENANT_PREFIXES = ["73db45ff", "e0fe9ea8", "5f05d826"];

const client = process.env.MIXPANEL_TOKEN
  ? Mixpanel.init(process.env.MIXPANEL_TOKEN)
  : null;

type Scalar = string | number | boolean | null | undefined;

export type TrackProps = {
  tenant_id?: string;
  user_id?: string;
} & Record<string, Scalar>;

export function isInternalTenant(tenant_id: string): boolean {
  return INTERNAL_TENANT_PREFIXES.some((p) => tenant_id.startsWith(p));
}

export function track(event: string, props: TrackProps): void {
  if (!client) return;
  const { user_id, tenant_id, ...rest } = props;
  client.track(
    event,
    {
      distinct_id: user_id ?? tenant_id ?? "server",
      ...(tenant_id ? { tenant_id, is_internal: isInternalTenant(tenant_id) } : {}),
      ...rest,
    },
    (err) => {
      if (err) console.warn(`[mixpanel] track ${event} failed: ${err.message}`);
    },
  );
}

export function setProfile(user_id: string, props: Record<string, Scalar>): void {
  if (!client) return;
  client.people.set(user_id, props, (err) => {
    if (err) console.warn(`[mixpanel] people.set failed: ${err.message}`);
  });
}
