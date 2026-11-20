import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useSession } from "../lib/useSession";
import { NotConfigured } from "../components/NotConfigured";

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

export default function AuthCallback() {
  const navigate = useNavigate();
  const { session, loading } = useSession();
  const [error, setError] = useState("");

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(window.location.search);
    const err = hash.get("error_description") ?? query.get("error_description");
    if (err) setError(err);
  }, []);

  useEffect(() => {
    if (loading || !session) return;
    navigate(safeNext(new URLSearchParams(window.location.search).get("next")), { replace: true });
  }, [loading, session, navigate]);

  if (!supabase) return <NotConfigured />;
  if (error) {
    return (
      <p data-zavi="auth-error" className="text-sm text-danger">
        Sign-in failed: {error}
      </p>
    );
  }
  if (!loading && !session) {
    return (
      <p data-zavi="auth-expired" className="text-sm">
        This sign-in link has expired or was already used. <a href="/login">Request a new one.</a>
      </p>
    );
  }
  return <p className="text-sm text-muted-foreground">Signing you in...</p>;
}
