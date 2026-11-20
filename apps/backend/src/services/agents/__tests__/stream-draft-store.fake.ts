export type DraftRow = { run_id: string; tenant_id: string; seq: number; text: string; status: string; writer_generation: number; writer_seq: number };
export type Attempt = { kind: "write"; row: DraftRow; signal?: AbortSignal };
export function draftStore(beforeCommit: (attempt: Attempt) => Promise<void> = async () => {}) {
  let stored: DraftRow | undefined;
  let generation = 0;
  const attempts: Attempt[] = [];
  return {
    get stored() { return stored; }, attempts,
    sb: { rpc(name: string, p: Record<string, any>) {
      if (name === "begin_stream_draft_writer") {
        const data = ++generation;
        return { abortSignal: () => Promise.resolve({ data, error: null }) };
      }
      if (name !== "write_stream_draft") throw new Error("unexpected RPC");
      const attempt: Attempt = { kind: "write", row: {
        run_id:p.p_run_id, tenant_id:p.p_tenant_id, seq:p.p_seq,
        writer_generation:p.p_generation, writer_seq:p.p_seq, text:p.p_text, status:p.p_status,
      } };
      attempts.push(attempt);
      return { abortSignal(signal: AbortSignal) {
        attempt.signal = signal;
        return (async () => {
          await beforeCommit(attempt);
          const row = attempt.row;
          const accept = !stored || (stored.tenant_id===row.tenant_id &&
            (stored.writer_generation<row.writer_generation ||
             (stored.writer_generation===row.writer_generation && stored.writer_seq<row.writer_seq)));
          if (accept) stored = { ...row, seq:(stored?.seq ?? 0)+1 };
          return { data:accept, error:null };
        })();
      } };
    } } as never,
  };
}
