import { useEffect, useRef } from "react";
import { useAuth } from "../auth/AuthProvider";
import { onTenantDisabled, TENANT_DISABLED_MESSAGE } from "../lib/tenantDisabled";
import { showDialog } from "./DialogHost";

export function TenantDisabledWatcher() {
  const { signOut } = useAuth();
  const open = useRef(false);
  useEffect(
    () =>
      onTenantDisabled(() => {
        if (open.current) return;
        open.current = true;
        void showDialog({ title: "Workspace disabled", message: TENANT_DISABLED_MESSAGE, confirmLabel: "Sign out" })
          .then(() => signOut())
          .finally(() => {
            open.current = false;
          });
      }),
    [signOut],
  );
  return null;
}
