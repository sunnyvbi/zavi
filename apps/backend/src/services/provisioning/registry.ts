
import type { Provisioner, ResourceKind } from "./types";

const registry = new Map<ResourceKind, Provisioner>();

export function registerProvisioner(p: Provisioner): void {
  registry.set(p.kind, p);
}

export function getProvisioner(kind: ResourceKind): Provisioner | null {
  return registry.get(kind) ?? null;
}

export function listProvisioners(): ResourceKind[] {
  return [...registry.keys()];
}

export function _resetProvisioners(): void {
  registry.clear();
}
