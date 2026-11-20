
import { ASPECT_VALUES, type Aspect } from "./brief-mapper";

export function resolveRenderAspects(requested: unknown, briefAspect: Aspect | undefined): Aspect[] {
  const valid = new Set<string>(ASPECT_VALUES);
  if (Array.isArray(requested)) {
    const picked = [...new Set(requested.filter((a): a is Aspect => typeof a === "string" && valid.has(a)))];
    if (picked.length > 0) return picked;
  }
  return [briefAspect && valid.has(briefAspect) ? briefAspect : "16:9"];
}

export function aspectArtifactFilename(aspect: Aspect, variantLabel?: string): string {
  const v = variantLabel ? `-${variantLabel}` : "";
  return `video${v}-${aspect.replace(":", "x")}.mp4`;
}
