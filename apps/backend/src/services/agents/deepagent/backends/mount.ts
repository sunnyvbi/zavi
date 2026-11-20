
import { CompositeBackend, StateBackend, type FilesystemPermission } from "deepagents";
import { ZaviMemoryBackend } from "./zavi-memory-backend";

export type MountOptions = {
  tenantId: string;
  runId?: string | null;
  agentSlug?: string | null;
  mountMemory?: boolean;
};

export const ZAVI_FS_PERMISSIONS: readonly FilesystemPermission[] = [
  { operations: ["write"], paths: ["/memory/**"], mode: "deny" },
  { operations: ["write"], paths: ["/skills/**"], mode: "deny" },
  { operations: ["read"], paths: ["/memory/**", "/skills/**"], mode: "allow" },
  { operations: ["read", "write"], paths: ["/**"], mode: "allow" },
] as const;

export function buildBackend(opts: MountOptions): CompositeBackend {
  const routes: Record<string, ZaviMemoryBackend> = {};
  if (opts.mountMemory !== false) {
    routes["/memory/"] = new ZaviMemoryBackend({
      tenantId: opts.tenantId,
      runId: opts.runId,
      agentSlug: opts.agentSlug,
    });
  }
  return new CompositeBackend(new StateBackend(), routes);
}
