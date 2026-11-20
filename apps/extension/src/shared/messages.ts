
export type AuthLaunchRequest = {
  type: "zavi:auth:launch";
  url: string;
};

export type AuthLaunchResponse =
  | { ok: true; redirectUrl: string }
  | { ok: false; error: string };

export type PanelMessage = AuthLaunchRequest;

export function isAuthLaunchRequest(m: unknown): m is AuthLaunchRequest {
  return (
    typeof m === "object" &&
    m !== null &&
    (m as { type?: unknown }).type === "zavi:auth:launch" &&
    typeof (m as { url?: unknown }).url === "string"
  );
}
