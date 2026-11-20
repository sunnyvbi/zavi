
import type { ResolvedVariant } from "./variant-config";

export type BehaviorRegistry = Record<string, { description: string }>;

export const BEHAVIORS: BehaviorRegistry = {};

export function variantBehaviorOn(variant: ResolvedVariant | undefined | null, name: string): boolean {
  return variant?.config.behaviors?.includes(name) === true;
}
