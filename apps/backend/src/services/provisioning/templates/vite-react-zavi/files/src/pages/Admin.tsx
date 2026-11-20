import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { zavi, type ZaviRecord } from "../zavi";
import { useIsAdmin, useSession } from "../zavi/react";

type Submission = { name: string; email?: string; body: string; status?: "new" | "done" };

export default function Admin() {
  const fromZavi = new URLSearchParams(useLocation().search).get("from") === "zavi";
  const { session, user, loading: sessionLoading } = useSession();
  const { isAdmin, loading } = useIsAdmin();
  const [messages, setMessages] = useState<ZaviRecord<Submission>[] | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    zavi.data
      .collection<Submission>("submissions")
      .list({ limit: 50 })
      .then((page) => setMessages(page.items))
      .catch(() => setMessages([]));
  }, [isAdmin]);

  if (sessionLoading || loading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (!session) {
    return (
      <p data-zavi="admin-signin" className="text-sm">
        Please <Link to={fromZavi ? "/login?next=/admin&from=zavi" : "/login?next=/admin"} className="underline">sign in</Link> to continue.
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
          onClick={() => zavi.auth.signOut()}
          className="rounded border border-border px-3 py-1.5 text-sm"
        >
          Sign out
        </button>
      </div>
      <p className="text-sm text-muted-foreground">{user?.email ? `Signed in as ${user.email}.` : "You are signed in."}</p>
      <div data-zavi="admin-sections" className="space-y-3">
        <h2 className="text-lg font-semibold">Form submissions</h2>
        {messages === null ? (
          <p className="text-sm text-muted-foreground">Loading submissions...</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No submissions yet.</p>
        ) : (
          <ul className="space-y-2">
            {messages.map((m) => (
              <li key={m.id} data-zavi="message-row" className="rounded border border-border p-3 text-sm">
                <p className="font-medium">
                  {m.data.name}
                  {m.data.email ? <span className="font-normal text-muted-foreground"> &middot; {m.data.email}</span> : null}
                </p>
                <p className="whitespace-pre-wrap text-muted-foreground">{m.data.body}</p>
                <p className="text-xs text-muted-foreground">{new Date(m.created_at).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
