import { useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { NotConfigured } from "../components/NotConfigured";

export default function Login() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  if (!supabase) return <NotConfigured />;
  const client = supabase;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setMessage("");
    const { error } = await client.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setStatus("error");
      setMessage(error.message);
      return;
    }
    setStatus("sent");
  }

  return (
    <section className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {status === "sent" ? (
        <p data-zavi="login-sent" className="text-sm">
          Check your email for a sign-in link.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="login-email">
            Email
          </label>
          <input
            id="login-email"
            data-zavi="login-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-border px-3 py-2"
          />
          <button
            data-zavi="login-submit"
            type="submit"
            disabled={status === "sending"}
            className="w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {status === "sending" ? "Sending..." : "Email me a sign-in link"}
          </button>
          {status === "error" && (
            <p data-zavi="login-error" className="text-sm text-danger">
              {message}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
