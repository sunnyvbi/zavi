import { apiFetch } from "@/lib/api";

export class WebsiteSessionExpired extends Error {
  constructor() {
    super("Your session expired. Sign in to continue.");
  }
}

export async function websitePost(
  path: string,
  body: unknown,
  timeout = 130_000,
  headers?: Record<string, string>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await apiFetch(path, {
      method: "POST",
      body: JSON.stringify(body),
      signal: controller.signal,
      retryOnNetworkError: false,
      ...(headers ? { headers } : {}),
    });
    if (response.status === 401) throw new WebsiteSessionExpired();
    return response;
  } finally {
    clearTimeout(timer);
  }
}
