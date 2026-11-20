
import { useState, type JSX } from "react";

export function CrashScreen(props: { error: unknown; onReload: () => void }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const detail = describe(props.error);

  return (
    <div className="zv-crash" role="alert">
      <h1 className="zv-crash-title">Zavi hit an error and stopped</h1>
      <p className="zv-crash-lead">
        This is a bug in Zavi, not something you did. Reloading may clear it. If it
        keeps happening, send the detail below.
      </p>

      <pre className="zv-crash-detail">{detail}</pre>

      <div className="zv-crash-actions">
        <button type="button" className="zv-crash-primary" onClick={props.onReload}>
          Reload the panel
        </button>
        <button
          type="button"
          className="zv-crash-quiet"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(detail)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? "Copied" : "Copy detail"}
        </button>
      </div>
    </div>
  );
}

export function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.stack && error.stack.includes(error.message)
      ? error.stack
      : `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, null, 2) ?? String(error);
  } catch {
    return String(error);
  }
}
