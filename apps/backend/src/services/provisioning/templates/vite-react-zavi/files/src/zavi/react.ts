import { useEffect, useMemo, useState } from "react";
import { zavi } from "./index";
import type { Session, User } from "./client";

export function useSession(): { session: Session | null; user: User | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(zavi.auth.session());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const off = zavi.auth.onChange((s) => { if (active) setSession(s); });
    zavi.auth.ready()
      .catch(() => null)
      .finally(() => {
        if (!active) return;
        setSession(zavi.auth.session());
        setLoading(false);
      });
    return () => { active = false; off(); };
  }, []);

  const token = session?.access_token ?? null;
  const user = useMemo(() => (token ? zavi.auth.user() : null), [token]);
  return { session, user, loading };
}

export function useIsAdmin(): { isAdmin: boolean; loading: boolean } {
  const { user, loading } = useSession();
  return { isAdmin: !loading && user?.role === "admin", loading };
}
