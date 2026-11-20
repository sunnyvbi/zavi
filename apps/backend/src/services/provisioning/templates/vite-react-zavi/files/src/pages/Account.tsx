import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { isReauthRequired, zavi } from "../zavi";
import { useSession } from "../zavi/react";

export default function Account() {
  const navigate = useNavigate();
  const { user, loading } = useSession();
  const [params] = useSearchParams();
  const welcome = params.get("welcome") === "1";
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [current, setCurrent] = useState("");
  const [needsCurrent, setNeedsCurrent] = useState(false);
  const [message, setMessage] = useState("");

  if (loading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (!user) {
    return (
      <p data-zavi="account-signin" className="text-sm">
        Please <Link to="/login" className="underline">sign in</Link> to continue.
      </p>
    );
  }

  async function guarded(action: () => Promise<void>, ok: string) {
    setMessage("");
    try {
      await action();
      setMessage(ok);
      setNeedsCurrent(false);
      setCurrent("");
    } catch (err) {
      if (isReauthRequired(err)) {
        setNeedsCurrent(true);
        setMessage("For your security, enter your current password (or sign in again) to continue.");
      } else setMessage("Could not save. Check the value and try again.");
    }
  }
  const cur = () => (current ? { currentPassword: current } : {});

  const onPassword = (e: FormEvent) => {
    e.preventDefault();
    guarded(async () => {
      await zavi.auth.updatePassword(password, cur());
      setPassword("");
      if (welcome) navigate("/", { replace: true });
    }, "Password saved.");
  };
  const onEmail = (e: FormEvent) => {
    e.preventDefault();
    guarded(() => zavi.auth.changeEmail({ email, ...cur() }), "Check your new inbox to confirm the change.");
  };
  const onDelete = () => {
    if (!window.confirm("Delete your account? This cannot be undone.")) return;
    guarded(async () => {
      await zavi.auth.deleteAccount(cur());
      navigate("/");
    }, "Account deleted.");
  };

  return (
    <section data-zavi="account" className="mx-auto max-w-sm space-y-6">
      {welcome ? (
        <div data-zavi="account-welcome" className="space-y-1">
          <h1 className="text-2xl font-semibold">Set your password</h1>
          <p className="text-sm text-muted-foreground">
            Your email is confirmed and you are signed in. Step 2 of 2: choose a password (8 to 72 characters) to
            sign in with next time.
          </p>
        </div>
      ) : (
        <>
          <h1 className="text-2xl font-semibold">Account</h1>
          <p className="text-sm text-muted-foreground">{user.email ? `Signed in as ${user.email}.` : "You are signed in."}</p>
        </>
      )}
      {needsCurrent && (
        <div data-zavi="account-reauth" className="space-y-2 rounded border border-border p-3">
          <label className="block text-sm font-medium" htmlFor="account-current">
            Current password
          </label>
          <input
            id="account-current"
            data-zavi="account-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="w-full rounded border border-border px-3 py-2"
          />
          <p className="text-xs text-muted-foreground">
            Or <Link to="/login" className="underline">sign in again</Link>.
          </p>
        </div>
      )}
      <form onSubmit={onPassword} className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="account-password">
          New password
        </label>
        <input
          id="account-password"
          data-zavi="account-password"
          type="password"
          minLength={8}
          maxLength={72}
          required
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded border border-border px-3 py-2"
        />
        <button type="submit" className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
          Save password
        </button>
      </form>
      <form onSubmit={onEmail} className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="account-email">
          New email
        </label>
        <input
          id="account-email"
          data-zavi="account-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded border border-border px-3 py-2"
        />
        <button type="submit" className="rounded border border-border px-4 py-2 text-sm">
          Change email
        </button>
      </form>
      {message && (
        <p data-zavi="account-message" className="text-sm">
          {message}
        </p>
      )}
      <div className="flex gap-3">
        <button
          data-zavi="account-signout"
          type="button"
          onClick={() => zavi.auth.signOut().then(() => navigate("/"))}
          className="rounded border border-border px-3 py-1.5 text-sm"
        >
          Sign out
        </button>
        <button data-zavi="account-delete" type="button" onClick={onDelete} className="rounded border border-border px-3 py-1.5 text-sm text-danger">
          Delete account
        </button>
      </div>
    </section>
  );
}
