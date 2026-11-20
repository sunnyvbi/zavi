export type PushData =
  | { type?: string; thread_id?: string | null; agent_slug?: string | null }
  | undefined;

export type PushTarget =
  | { pathname: "/chat"; params?: { thread_id: string; slug?: string } }
  | { pathname: "/growth" }
  | { pathname: "/toolkit" };

export function pushTarget(data: PushData): PushTarget {
  switch (data?.type) {
    case "growth_lead":
    case "result_milestone":
      return { pathname: "/growth" };
    case "connector_broke":
      return { pathname: "/toolkit" };
    default:
      if (!data?.thread_id) return { pathname: "/chat" };
      return {
        pathname: "/chat",
        params: data.agent_slug
          ? { thread_id: data.thread_id, slug: data.agent_slug }
          : { thread_id: data.thread_id },
      };
  }
}
