
export const DISTILL_PER_TENANT_CONCURRENCY = 4;
export const DISTILL_GLOBAL_CONCURRENCY = 8;

export const DISTILL_TENANT_KEY_C8reverified = true;

type DistillConcurrencyOption = { scope: "fn"; key: string; limit: number };

export function distillConcurrency(
  globalKey: string,
): [DistillConcurrencyOption, DistillConcurrencyOption] {
  return [
    { scope: "fn", key: "event.data.tenant_id", limit: DISTILL_PER_TENANT_CONCURRENCY },
    { scope: "fn", key: `"${globalKey}"`, limit: DISTILL_GLOBAL_CONCURRENCY },
  ];
}
