import { useMutation } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../auth/AuthProvider";
import { useWorkspace } from "../workspaces/WorkspaceProvider";

export function useAcceptInvite() {
  const { session } = useAuth();
  const { refresh } = useWorkspace();
  const userId = session?.user?.id ?? null;
  return useMutation({
    mutationFn: async (inviteId: string): Promise<{ switched: boolean }> => {
      await apiJson<{ ok: true }>("/api/v1/members/accept", {
        method: "POST",
        body: JSON.stringify({ inviteId }),
      });
      if (!userId) return { switched: false };
      const { data: profile } = await supabase
        .from("profiles")
        .select("active_tenant_id")
        .eq("user_id", userId)
        .maybeSingle();
      const invited = (profile?.active_tenant_id as string | null | undefined) ?? null;
      return { switched: !!invited && (await refresh(invited)) };
    },
  });
}
