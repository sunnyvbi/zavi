
import { useState, type JSX } from "react";
import type { Session } from "@supabase/supabase-js";
import { AuthError, GENERIC_MESSAGE, signInWithZavi } from "../auth";
import { ZaviMark } from "./icons";

type Props = {
  onSignedIn: (session: Session) => void;
};

export function SignIn(props: Props): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      props.onSignedIn(await signInWithZavi());
    } catch (e) {
      setError(e instanceof AuthError ? e.message : GENERIC_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="zv-screen zv-signin">
      <div className="zv-screen-body zv-signin-body">
        {}
        <ZaviMark className="zv-screen-mark" size={28} />
        <h2 className="zv-screen-title">Ask about the tab you are on</h2>
        <p className="zv-screen-lead">
          Zavi reads the page when you ask it to, answers in this panel, and
          does the work in your Zavi account. Same account, same history as the
          web app.
        </p>
      </div>

      <div className="zv-screen-actions">
        <button
          type="button"
          className="zv-primary"
          disabled={busy}
          onClick={() => void go()}
        >
          {busy ? "Opening sign in..." : "Sign in with Zavi"}
        </button>
        <div className="zv-screen-status">
          {error ? (
            <p className="zv-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="zv-hint">
              Opens zaviagent.com in a new window. No new password.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
