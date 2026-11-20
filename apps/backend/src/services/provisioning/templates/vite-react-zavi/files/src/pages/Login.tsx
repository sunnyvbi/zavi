import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { zavi, ZaviError } from "../zavi";
import { useCaptcha } from "../zavi/captcha";

export default function Login() {
  const navigate = useNavigate();
  const query = new URLSearchParams(useLocation().search);
  const forAdmin = query.get("next") === "/admin";
  const fromZavi = forAdmin && query.get("from") === "zavi";
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "busy" | "link-sent" | "reset-sent" | "check-email" | "error">("idle");
  const [sentTo, setSentTo] = useState("");
  const [message, setMessage] = useState("");
  const captcha = useCaptcha();

  async function run(action: () => Promise<void>) {
    setStatus("busy");
    setMessage("");
    try {
      await action();
    } catch (err) {
      captcha.reset();
      setStatus("error");
      setMessage(
        err instanceof ZaviError && err.reason === "invalid_credentials"
          ? fromZavi
            ? "Wrong email or password. First time? Use \"Email me a sign-in link\". Your Zavi password does not work here."
            : forAdmin
              ? "Wrong email or password. If you own this site, use \"Email me a sign-in link\"."
              : "Wrong email or password."
          : err instanceof ZaviError && err.code === "conflict" ? "That email already has an account. Sign in instead."
            : err instanceof ZaviError && err.code === "rate_limited" ? "Too many attempts. Wait a minute and try again."
              : err instanceof ZaviError && err.code === "validation"
                ? mode === "signup" ? "Check the email address and try again." : "Check the email, and use a password of 8 to 72 characters."
                : err instanceof ZaviError && err.reason.startsWith("turnstile_") ? "Complete the check above, then try again."
                  : "Something went wrong. Try again.",
      );
    }
  }

  const switchTo = (next: "signin" | "signup") => {
    setMode(next);
    setStatus("idle");
    setMessage("");
    setPassword("");
  };

  const signIn = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await zavi.auth.signIn({ email, password });
      navigate("/admin");
    });
  };
  const signUp = (e?: FormEvent) => {
    e?.preventDefault();
    run(async () => {
      const { confirmationRequired } = await zavi.auth.signUp(email, { captchaToken: captcha.token ?? undefined });
      setSentTo(email.trim());
      if (confirmationRequired) setStatus("check-email");
      else navigate("/account?welcome=1");
    });
  };
  const emailLink = () =>
    run(async () => {
      await zavi.auth.signInWithMagicLink({ email, next: "/admin", captchaToken: captcha.token ?? undefined });
      if (zavi.auth.session()) navigate("/admin");
      else {
        setSentTo(email.trim());
        setStatus("link-sent");
      }
    });
  const forgotPassword = () => {
    if (!email.trim()) {
      setStatus("error");
      setMessage("Enter your email above, then press \"Forgot password?\" again.");
      return;
    }
    run(async () => {
      await zavi.auth.resetPassword({ email, captchaToken: captcha.token ?? undefined });
      setSentTo(email.trim());
      setStatus("reset-sent");
    });
  };

  if (status === "check-email") {
    return (
      <section data-zavi="signup-sent" className="mx-auto max-w-sm space-y-2 text-sm">
        <h1 className="text-2xl font-semibold">Check your email</h1>
        <p>
          <strong>Step 1 of 2.</strong> We sent a confirmation link to {sentTo}. Open it in this browser and
          press Confirm.
        </p>
        <p>
          <strong>Step 2 of 2.</strong> You will land on your account page signed in. Choose a password there
          so you can sign in with it next time.
        </p>
        <p className="text-muted-foreground">No email after a few minutes? Check spam, or try again.</p>
      </section>
    );
  }
  if (status === "link-sent") {
    return (
      <section data-zavi="login-sent" className="mx-auto max-w-sm space-y-2 text-sm">
        <p>If {sentTo || "that address"} has an account here, a sign-in link is on its way. Open it in this browser.</p>
        <p className="text-muted-foreground">It can take up to a minute. Check spam too, or try again in a minute.</p>
      </section>
    );
  }

  if (status === "reset-sent") {
    return (
      <section data-zavi="reset-sent" className="mx-auto max-w-sm space-y-2 text-sm">
        <p>
          If {sentTo || "that address"} has an account here, a password reset link is on its way. Open it in this
          browser, then choose a new password.
        </p>
        <p className="text-muted-foreground">It can take up to a minute. Check spam too, or try again in a minute.</p>
      </section>
    );
  }

  const emailField = (
    <>
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
    </>
  );
  const error = status === "error" && (
    <p data-zavi="login-error" className="text-sm text-danger">
      {message}
    </p>
  );

  if (mode === "signup") {
    return (
      <section className="mx-auto max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">Create your account</h1>
        <form data-zavi="signup-form" onSubmit={signUp} className="space-y-3">
          {emailField}
          <p className="text-sm text-muted-foreground">
            No password yet. We email you a link to confirm your address, then you choose a password.
          </p>
          {captcha.widget}
          <button
            data-zavi="login-signup"
            type="submit"
            disabled={status === "busy"}
            className="w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            Create account
          </button>
          <button data-zavi="login-to-signin" type="button" onClick={() => switchTo("signin")} className="text-sm underline">
            Already have an account? Sign in
          </button>
          {error}
        </form>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <form onSubmit={signIn} className="space-y-3">
        {emailField}
        <label className="block text-sm font-medium" htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          data-zavi="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded border border-border px-3 py-2"
        />
        <button
          data-zavi="login-submit"
          type="submit"
          disabled={status === "busy"}
          className="w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          Sign in
        </button>
        {captcha.widget}
        <div className="flex flex-wrap justify-between gap-2 text-sm">
          <button data-zavi="login-to-signup" type="button" onClick={() => switchTo("signup")} className="underline">
            Create account
          </button>
          <button data-zavi="login-link" type="button" onClick={emailLink} className="underline">
            Email me a sign-in link
          </button>
          <button data-zavi="login-forgot" type="button" onClick={forgotPassword} className="underline">
            Forgot password?
          </button>
        </div>
        {error}
      </form>
    </section>
  );
}
