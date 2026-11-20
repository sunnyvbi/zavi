import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useSession } from "../lib/useSession";
import { useIsAdmin } from "../lib/useIsAdmin";
import { NotConfigured } from "../components/NotConfigured";

export default function Admin() {
  const { session, loading: sessionLoading } = useSession();
  const { isAdmin, loading } = useIsAdmin();

  if (!supabase) return <NotConfigured />;
  const client = supabase;
  if (sessionLoading || loading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (!session) {
    return (
      <p data-zavi="admin-signin" className="text-sm">
        Please <Link to="/login" className="underline">sign in</Link> to continue.
      </p>
    );
  }
  if (!isAdmin) {
    return (
      <p data-zavi="admin-denied" className="text-sm">
        This account does not have admin access.
      </p>
    );
  }

  return (
    <section data-zavi="admin-shell" className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <button
          data-zavi="admin-signout"
          type="button"
          onClick={() => client.auth.signOut()}
          className="rounded border border-border px-3 py-1.5 text-sm"
        >
          Sign out
        </button>
      </div>
      <p className="text-sm text-muted-foreground">Signed in as {session.user.email}.</p>
      <div data-zavi="admin-sections" className="grid gap-4 sm:grid-cols-2">
        <div className="rounded border border-border p-4 text-sm text-muted-foreground">
          Nothing to manage yet.
        </div>
      </div>
    </section>
  );
}
