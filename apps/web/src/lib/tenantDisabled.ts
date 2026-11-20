
export const TENANT_DISABLED_CODE = "tenant_disabled";
export const TENANT_DISABLED_EVENT = "zavi:tenant-disabled";
export const TENANT_DISABLED_MESSAGE = "This workspace is disabled. Contact support@zaviagent.com.";

export async function noticeTenantDisabled(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    const body = (await res.clone().json()) as { error?: { code?: unknown } } | null;
    if (body?.error?.code !== TENANT_DISABLED_CODE) return false;
  } catch {
    return false;
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(TENANT_DISABLED_EVENT));
  return true;
}
