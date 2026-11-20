import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { zavi } from "../zavi";
import { runConfirm } from "../zavi/confirm";

export default function Confirm() {
  const navigate = useNavigate();
  const [state, setState] = useState<{ error?: string; done?: string }>({});

  useEffect(() => {
    let active = true;
    let pending: Storage | null = null;
    try { pending = window.sessionStorage; } catch { pending = null; }
    runConfirm(zavi, window.location.href, {
      pending,
      replaceUrl: (url) => window.history.replaceState(null, "", url),
      navigate: (url) => window.location.replace(url),
    })
      .then((r) => {
        if (!active) return;
        if (r.kind === "signed_in") navigate(r.next, { replace: true });
        else if (r.kind === "email_changed") setState({ done: "Your email address was changed." });
        else if (r.kind === "signup_confirmed") setState({ done: "Your email is confirmed. Sign in with an email link from the sign-in page, then set a password on your account page." });
        else if (r.kind === "error") setState({ error: r.message });
      })
      .catch(() => active && setState({ error: "Something went wrong. Open the link again." }));
    return () => {
      active = false;
    };
  }, [navigate]);

  if (state.error) {
    return (
      <p data-zavi="auth-error" className="text-sm">
        {state.error} <Link to="/login" className="underline">Back to sign in</Link>
      </p>
    );
  }
  if (state.done) return <p data-zavi="auth-done" className="text-sm">{state.done}</p>;
  return <p className="text-sm text-muted-foreground">Signing you in...</p>;
}
