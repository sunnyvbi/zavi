
export const TENANT_DISABLED_CODE = "tenant_disabled";
export const TENANT_DISABLED_MESSAGE = "This workspace is disabled. Contact support@zaviagent.com.";

let handler: (() => void) | null = null;

export function onTenantDisabled(fn: () => void): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

export async function noticeTenantDisabled(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    const body = (await res.clone().json()) as { error?: { code?: unknown } } | null;
    if (body?.error?.code !== TENANT_DISABLED_CODE) return false;
  } catch {
    return false;
  }
  handler?.();
  return true;
}
