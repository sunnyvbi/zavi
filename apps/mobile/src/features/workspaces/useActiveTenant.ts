import { useWorkspace } from "./WorkspaceProvider";

export function useActiveTenant(): string {
  const { activeTenantId } = useWorkspace();
  return activeTenantId ?? "none";
}
