import { requestHash, type Operation, type OperationStore } from "./operations";

export function memoryStore(): OperationStore & { rows: Map<string, Operation> } {
  const rows = new Map<string, Operation>();
  return {
    rows,
    async read(step) { return rows.get(step) ?? null; },
    async list() { return [...rows.values()]; },
    async claim(step, request) {
      const prior = rows.get(step);
      if (prior && !(prior.state === "failed" && prior.request_hash === requestHash(request))) return false;
      rows.set(step, { step, state: "running", request, request_hash: requestHash(request), result: null });
      return true;
    },
    async save(step, state, result) {
      const row = rows.get(step);
      if (!row) throw new Error("Missing operation");
      rows.set(step, { ...row, state, result });
    },
  };
}
