import { connectErrorCopy, type ConnectResult } from "./connectResult";

const SESSION_BOUND: ReadonlySet<string> = new Set(["linkedin_ads"]);

export type FinishRequest = { slug: string; code: string; state: string };

type Params = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

export function readFinishRequest(params: Params): FinishRequest | null {
  const slug = one(params.connector);
  const code = one(params.code);
  const state = one(params.state);
  if (!SESSION_BOUND.has(slug) || !code || !state) return null;
  return { slug, code, state };
}

const started = new Map<string, Promise<ConnectResult>>();

const refusesTheLinkForGood = (status: unknown): boolean =>
  typeof status === "number" && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;

async function run(
  req: FinishRequest,
  complete: (slug: string, code: string, state: string) => Promise<unknown>,
  labelFor: (slug: string) => string,
): Promise<ConnectResult> {
  try {
    await complete(req.slug, req.code, req.state);
    return { kind: "connected", slug: req.slug };
  } catch (e) {
    const failure = e as { status?: unknown; code?: unknown };
    const name = labelFor(req.slug);
    if (!refusesTheLinkForGood(failure?.status)) started.delete(req.state);
    if (failure?.status === 401) {
      return { kind: "failed", slug: req.slug, message: `Sign in to Zavi, then tap Connect to link ${name} again.` };
    }
    return {
      kind: "failed",
      slug: req.slug,
      message: connectErrorCopy(typeof failure?.code === "string" ? failure.code : "failed", name),
    };
  }
}

export function finishConnect(
  req: FinishRequest,
  complete: (slug: string, code: string, state: string) => Promise<unknown>,
  labelFor: (slug: string) => string,
): Promise<ConnectResult> {
  const running = started.get(req.state);
  if (running) return running;
  const result = run(req, complete, labelFor);
  started.set(req.state, result);
  return result;
}
