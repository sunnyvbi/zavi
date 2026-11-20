import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import type { Skill } from "./skillText";

const skillsKey = (tenant: string) => ["skills", tenant] as const;

export function useSkills() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: skillsKey(tenant),
    queryFn: async () =>
      (await apiJson<{ notes?: Skill[] }>("/api/memory/notes?note_type=skill&authored=operator"))?.notes ?? [],
    enabled: tenant !== "none",
  });
}

export type SkillInput = { id: string | null; title: string; body_markdown: string; tags: string[] };

export function useSaveSkill() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: (s: SkillInput) =>
      apiJson("/api/memory/notes", {
        method: "POST",
        body: JSON.stringify({
          ...(s.id ? { id: s.id } : {}),
          note_type: "skill",
          title: s.title,
          body_markdown: s.body_markdown,
          tags: s.tags,
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillsKey(tenant) }),
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: (id: string) => apiJson(`/api/memory/notes/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillsKey(tenant) }),
  });
}
