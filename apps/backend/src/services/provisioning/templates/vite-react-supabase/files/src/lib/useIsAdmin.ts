import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { useSession } from "./useSession";

export function useIsAdmin(): { isAdmin: boolean; loading: boolean } {
  const { session, loading: sessionLoading } = useSession();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (sessionLoading) return;
    if (!supabase || !userId) {
      setIsAdmin(false);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    supabase.rpc("is_admin").then(({ data, error }) => {
      if (!active) return;
      setIsAdmin(!error && data === true);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [userId, sessionLoading]);

  return { isAdmin, loading: sessionLoading || loading };
}
