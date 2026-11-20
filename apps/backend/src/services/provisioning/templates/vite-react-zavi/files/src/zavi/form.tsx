
import { useCallback, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { useCaptcha } from "./captcha";
import { ZaviError } from "./errors";
import { zavi } from "./index";

export type FormStatus = "idle" | "sending" | "sent" | "error";

export type PublicForm<T> = {
  submit(values: Partial<T>): Promise<void>;
  status: FormStatus;
  error: string;
  fields: ReactElement;
  reset(): void;
};

function newKey(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return "form_" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function errorText(err: unknown): string {
  if (err instanceof ZaviError) {
    if (err.code === "validation") return "Please check the form and try again.";
    if (err.reason.startsWith("turnstile_")) return "Complete the check above, then try again.";
    if (err.code === "rate_limited" || err.code === "quota") return "Too many messages right now. Try again in a minute.";
    if (err.code === "offline") return "You are offline. Try again when you are connected.";
  }
  return "Could not send. Try again.";
}

const HIDDEN: CSSProperties = { position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" };

export function usePublicForm<T extends Record<string, unknown> = Record<string, unknown>>(collection: string): PublicForm<T> {
  const captcha = useCaptcha();
  const [status, setStatus] = useState<FormStatus>("idle");
  const [error, setError] = useState("");
  const trap = useRef<HTMLInputElement | null>(null);
  const sending = useRef(false);
  const attempt = useRef<{ key: string; body: string } | null>(null);

  const submit = useCallback(
    async (values: Partial<T>) => {
      if (sending.current) return;
      if (trap.current?.value) {
        setStatus("sent");
        return;
      }
      const body = JSON.stringify(values);
      if (!attempt.current || attempt.current.body !== body) attempt.current = { key: newKey(), body };
      const key = attempt.current.key;
      sending.current = true;
      setStatus("sending");
      setError("");
      try {
        await zavi.data
          .collection<T>(collection)
          .create(values, { idempotencyKey: key, captchaToken: captcha.token ?? undefined });
        attempt.current = null;
        setStatus("sent");
      } catch (err) {
        setStatus("error");
        setError(errorText(err));
      } finally {
        captcha.reset();
        sending.current = false;
      }
    },
    [collection, captcha],
  );

  const fields = (
    <>
      <div aria-hidden="true" style={HIDDEN}>
        <label>
          Leave this empty
          <input ref={trap} type="text" name="website_url" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>
      {captcha.widget}
    </>
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError("");
  }, []);

  return { submit, status, error, fields, reset };
}
