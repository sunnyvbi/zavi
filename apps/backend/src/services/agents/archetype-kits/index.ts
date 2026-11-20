export {
  ARCHETYPE_SLUGS,
  ArchetypeKitSchema,
  parseArchetypeKit,
} from "@/services/agents/archetype-kits/types";
export type { ArchetypeKit, ArchetypeSlug } from "@/services/agents/archetype-kits/types";
export {
  ARCHETYPE_KITS,
  DEFAULT_ARCHETYPE,
  selectArchetype,
  kitBySlug,
  archetypeHintFor,
} from "@/services/agents/archetype-kits/registry";
export type {
  ArchetypeSelection,
  ArchetypeHint,
} from "@/services/agents/archetype-kits/registry";
