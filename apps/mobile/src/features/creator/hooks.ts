import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthProvider";
import { creatorApi, type CreatorJob, type CreatorPackage } from "./api";
import {
  fetchCreatorIdentity,
  identityMemberId,
  type CreatorIdentity,
} from "./identity";
import type { CreatorProbe } from "./phase";

const keys = {
  identity: (user: string) => ["creator", "identity", user] as const,
  inbox: (member: string) => ["creator", member, "inbox"] as const,
  briefs: (member: string) => ["creator", member, "briefs"] as const,
  jobs: (member: string, scope: string) => ["creator", member, "jobs", scope] as const,
  job: (member: string, id: string) => ["creator", member, "job", id] as const,
  earnings: (member: string) => ["creator", member, "earnings"] as const,
  storefront: (member: string) => ["creator", member, "storefront"] as const,
};

export function useCreatorIdentity() {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  return useQuery({
    queryKey: keys.identity(userId ?? "none"),
    queryFn: fetchCreatorIdentity,
    enabled: !!userId,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function useCreatorProbe(): CreatorProbe {
  const { data, isPending, isError } = useCreatorIdentity();
  const { session } = useAuth();
  if (!session) return "not_creator";
  if (isError) return "not_creator";
  if (isPending || !data) return "loading";
  return data.kind === "not_creator" ? "not_creator" : "creator";
}

function useMemberId(): string | null {
  const { data } = useCreatorIdentity();
  return identityMemberId(data as CreatorIdentity | undefined);
}

export function useCreatorMe() {
  const { data } = useCreatorIdentity();
  const identity = data as CreatorIdentity | undefined;
  return identity?.kind === "creator" ? identity.me : null;
}

export function useCreatorInbox() {
  const member = useMemberId();
  return useQuery({
    queryKey: keys.inbox(member ?? "none"),
    queryFn: creatorApi.inbox,
    enabled: !!member,
  });
}

export function useCreatorBriefs() {
  const member = useMemberId();
  return useQuery({
    queryKey: keys.briefs(member ?? "none"),
    queryFn: creatorApi.briefs,
    enabled: !!member,
  });
}

export function useCreatorJobs(scope: "active" | "all") {
  const member = useMemberId();
  return useQuery({
    queryKey: keys.jobs(member ?? "none", scope),
    queryFn: () => creatorApi.jobs(scope),
    enabled: !!member,
  });
}

export function useCreatorJob(orderId: string) {
  const member = useMemberId();
  return useQuery({
    queryKey: keys.job(member ?? "none", orderId),
    queryFn: () => creatorApi.job(orderId),
    enabled: !!member && !!orderId,
    select: (d) => d.job,
  });
}

export function useCreatorEarnings() {
  const member = useMemberId();
  return useQuery({
    queryKey: keys.earnings(member ?? "none"),
    queryFn: creatorApi.earnings,
    enabled: !!member,
  });
}

export function useCreatorStorefront() {
  const member = useMemberId();
  return useQuery({
    queryKey: keys.storefront(member ?? "none"),
    queryFn: creatorApi.storefront,
    enabled: !!member,
  });
}

function invalidateCreator(qc: QueryClient, member: string | null): Promise<void> {
  if (!member) return Promise.resolve();
  return qc.invalidateQueries({ queryKey: ["creator", member] }).then(() => undefined);
}

type JobResult = { ok: true; job: CreatorJob | null };

export function useAcceptJob() {
  const qc = useQueryClient();
  const member = useMemberId();
  return useMutation<JobResult, Error, string>({
    mutationFn: (orderId) => creatorApi.accept(orderId),
    onSuccess: () => invalidateCreator(qc, member),
  });
}

export function usePassJob() {
  const qc = useQueryClient();
  const member = useMemberId();
  return useMutation<JobResult, Error, { orderId: string; reason: string }>({
    mutationFn: ({ orderId, reason }) => creatorApi.pass(orderId, reason),
    onSuccess: () => invalidateCreator(qc, member),
  });
}

export function useRequestExtension() {
  const qc = useQueryClient();
  const member = useMemberId();
  return useMutation<JobResult, Error, { orderId: string; requestedDueAt: string; note: string }>({
    mutationFn: ({ orderId, requestedDueAt, note }) =>
      creatorApi.requestExtension(orderId, requestedDueAt, note),
    onSuccess: () => invalidateCreator(qc, member),
  });
}

export function useSendJobMessage() {
  const qc = useQueryClient();
  const member = useMemberId();
  return useMutation({
    mutationFn: ({ orderId, body }: { orderId: string; body: string }) =>
      creatorApi.sendMessage(orderId, body),
    onSuccess: () => invalidateCreator(qc, member),
  });
}

export function useMarkAlertRead() {
  const qc = useQueryClient();
  const member = useMemberId();
  return useMutation({
    mutationFn: (id: string) => creatorApi.markAlertRead(id),
    onSuccess: () => invalidateCreator(qc, member),
  });
}

export function useTogglePackage() {
  const qc = useQueryClient();
  const member = useMemberId();
  return useMutation<{ package: CreatorPackage }, Error, { packageId: string; active: boolean }>({
    mutationFn: ({ packageId, active }) => creatorApi.savePackage(packageId, { active }),
    onSuccess: () => invalidateCreator(qc, member),
  });
}

export function useSubmitWork() {
  const qc = useQueryClient();
  const member = useMemberId();
  return useMutation({
    mutationFn: ({
      orderId,
      files,
      note,
    }: {
      orderId: string;
      files: Parameters<typeof creatorApi.submit>[1];
      note: string;
    }) => creatorApi.submit(orderId, files, note),
    onSuccess: () => invalidateCreator(qc, member),
  });
}

export { invalidateCreator };
