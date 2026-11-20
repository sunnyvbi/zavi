"use client";

import type { Dispatch, SetStateAction } from "react";
import { InlineProposalModifyChat } from "@/components/agents/InlineProposalModifyChat";
import { ProposalCard } from "@/components/agents/ProposalCard";

type Decision = {
  id: string;
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown>;
  status: string;
  agent_slug?: string | null;
  emitted_at: string;
  dispatched_at: string | null;
  dispatch_error: string | null;
  revision?: {
    id: string;
    status: string;
    message: string;
    assistant_text: string | null;
    replacement_decision_id: string | null;
    last_error?: string | null;
    created_at: string;
  } | null;
};

type Bucket = { key: string; label: string; items: Decision[] };

type RecentConversation = {
  id: string;
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown>;
  decision_status: string;
  last_message: string;
  last_at: string;
};

function isRevisionActive(d: Decision): boolean {
  return d.revision?.status === "requested" || d.revision?.status === "running";
}

export function LegacyProposalList({
  buckets,
  total,
  recent,
  actingId,
  actErrors,
  modifyingId,
  setModifyingId,
  openConvoId,
  setOpenConvoId,
  confirmRejectId,
  armReject,
  act,
  load,
}: {
  buckets: Bucket[];
  total: number;
  recent: RecentConversation[];
  actingId: string | null;
  actErrors?: Record<string, string>;
  modifyingId: string | null;
  setModifyingId: Dispatch<SetStateAction<string | null>>;
  openConvoId: string | null;
  setOpenConvoId: Dispatch<SetStateAction<string | null>>;
  confirmRejectId: string | null;
  armReject: (id: string | null) => void;
  act: (id: string, action: "approve" | "reject") => void;
  load: () => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-4">
      {}
      {total > 0 && (
        <section>
          <h3 className="mb-[22px] text-[20px] font-semibold leading-[25px] text-[#0e0f11]">
            Approve Now ({total})
          </h3>
          <div className="flex flex-col gap-[19px]">
            {buckets.map((bucket) => (
              <div key={bucket.key}>
                <div className="mb-3 text-[16px] font-semibold leading-[24px] text-[#0e0f11]">
                  {bucket.label} ({bucket.items.length})
                </div>
                <div className="flex flex-col gap-4">
                  {bucket.items.map((d) => (
                    <ProposalCard
                      key={d.id}
                      figma
                      decisionClass={d.decision_class}
                      handler={d.handler}
                      body={d.body}
                      footer={
                        <>
                          {actErrors?.[d.id] && (
                            <div className="mt-2 rounded-[10px] border border-[#f1c0bc] bg-[#fdf2f1] px-3 py-2 text-[13px] font-medium text-[#c0392b]">
                              {actErrors[d.id]}
                            </div>
                          )}
                          <InlineProposalModifyChat
                            decision={d}
                            open={modifyingId === d.id}
                            onClose={() => setModifyingId(null)}
                            onSubmitted={async () => {
                              setModifyingId(null);
                              await load();
                            }}
                          />
                        </>
                      }
                      actions={
                        <>
                          <button
                            type="button"
                            disabled={actingId === d.id || isRevisionActive(d)}
                            title={isRevisionActive(d) ? "Revision requested" : undefined}
                            onClick={() => {
                              armReject(null);
                              void act(d.id, "approve");
                            }}
                            className="flex h-10 cursor-pointer items-center justify-center rounded-cta bg-[#0e0f11] px-4 py-2.5 text-[16px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {actingId === d.id ? "…" : "Approve"}
                          </button>
                          {}
                          <button
                            type="button"
                            disabled={actingId === d.id}
                            onClick={() => {
                              if (confirmRejectId === d.id) {
                                armReject(null);
                                void act(d.id, "reject");
                              } else {
                                armReject(d.id);
                              }
                            }}
                            className={`flex h-10 cursor-pointer items-center justify-center rounded-cta border px-4 py-2 text-[16px] font-semibold transition-colors disabled:opacity-50 ${
                              confirmRejectId === d.id
                                ? "border-[#f1c0bc] bg-[#fdf2f1] text-[#c0392b] hover:bg-[#fbe7e5]"
                                : "border-[#f0f0f0] bg-white text-[#1f1f1f] hover:bg-[#f7f4ee]"
                            }`}
                          >
                            {confirmRejectId === d.id ? "Confirm?" : "Reject"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setModifyingId((cur) => (cur === d.id ? null : d.id))}
                            className="flex h-10 cursor-pointer items-center justify-center rounded-cta px-4 py-2 text-[16px] font-semibold text-[#595959] transition-colors hover:bg-[#f1efe9] hover:text-ink"
                          >
                            Modify
                          </button>
                        </>
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {}
      {recent.length > 0 && (
        <section>
          <h3 className="mb-3 text-[16px] font-semibold leading-[24px] text-[#0e0f11]">
            Recent conversations ({recent.length})
          </h3>
          <div className="flex flex-col gap-4">
            {recent.map((c) => (
              <ProposalCard
                key={c.id}
                figma
                decisionClass={c.decision_class}
                handler={c.handler}
                body={c.body}
                footer={
                  openConvoId === c.id ? (
                    <InlineProposalModifyChat
                      decision={{
                        id: c.id,
                        decision_class: c.decision_class,
                        handler: c.handler,
                        body: c.body,
                      }}
                      open
                      readOnly
                      onClose={() => setOpenConvoId(null)}
                      onSubmitted={() => {}}
                    />
                  ) : null
                }
                actions={
                  <>
                    <span className="flex h-10 items-center rounded-[12px] bg-[#f4f4f4] px-3 text-[12px] font-semibold capitalize text-[#595959]">
                      {c.decision_status}
                    </span>
                    <button
                      type="button"
                      onClick={() => setOpenConvoId((cur) => (cur === c.id ? null : c.id))}
                      className="flex h-10 cursor-pointer items-center justify-center rounded-cta px-4 py-2 text-[16px] font-semibold text-[#595959] transition-colors hover:bg-[#f1efe9] hover:text-ink"
                    >
                      {openConvoId === c.id ? "Hide" : "View conversation"}
                    </button>
                  </>
                }
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
