import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "../lib/api";

type MobileConfig = {
  isSignupEnabled: boolean;
  isIosBillingEnabled: boolean;
};

export function isEmailSignupEnabled(config?: MobileConfig): boolean {
  return config?.isSignupEnabled !== false;
}

export function isBillingEnabled(config?: MobileConfig): boolean {
  return config?.isIosBillingEnabled === true;
}

export async function fetchMobileConfig(
  signal?: AbortSignal,
): Promise<MobileConfig> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort);
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 10_000);

  try {
    const response = await fetch(apiUrl("/api/mobile/config"), {
      signal: controller.signal,
    });
    if (!response.ok) {
      return { isSignupEnabled: true, isIosBillingEnabled: false };
    }
    const config = await response.json();
    return {
      isSignupEnabled: config?.isSignupEnabled !== false,
      isIosBillingEnabled: config?.isIosBillingEnabled === true,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { isSignupEnabled: true, isIosBillingEnabled: false };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function useSignupAvailability() {
  return useQuery({
    queryKey: ["mobile", "config"],
    queryFn: ({ signal }) => fetchMobileConfig(signal),
    networkMode: "always",
    staleTime: 30_000,
    refetchOnMount: "always",
    refetchInterval: 60_000,
    retry: false,
  });
}
