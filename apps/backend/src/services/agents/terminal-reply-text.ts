
import { chatFailureBubbleBody } from "./error-body";
import type { RunOutcome } from "./outcome-model";
import { STATUS_PHRASES } from "./run-status-projection";

export type TerminalRunRow = {
  status: string | null;
  output_text: string | null;
  error: string | null;
  parse_error: string | null;
  agent_slug: string | null;
  outcome?: Partial<RunOutcome> | null;
};

export type TerminalReply = {
  markdown: string;
  isError: boolean;
  salvaged: boolean;
};

const parseFailedStatusLine = STATUS_PHRASES.couldnt;

function renderFromParts(parts: {
  status: string | null;
  deliverableText: string | null;
  rawError: string | null;
  slug: string;
}): TerminalReply {
  const { status, slug } = parts;
  const deliverable = (parts.deliverableText ?? "").trim();

  if (status === "success") {
    return {
      markdown: deliverable.length > 0 ? deliverable : "Done - no output.",
      isError: false,
      salvaged: false,
    };
  }

  if (deliverable.length > 0) {
    const markdown =
      status === "parse_failed" ? `${parseFailedStatusLine}\n\n${deliverable}` : deliverable;
    return { markdown, isError: false, salvaged: true };
  }

  return { markdown: chatFailureBubbleBody(parts.rawError, slug), isError: true, salvaged: false };
}

export function selectReplyTextFromRow(run: TerminalRunRow): TerminalReply {
  const slug = run.agent_slug ?? "agent";

  const rowRawError =
    run.status === "parse_failed"
      ? run.parse_error ?? run.error ?? null
      : run.error ?? null;

  const reply = run.outcome
    ? renderFromParts({
        status: run.status,
        deliverableText:
          (typeof run.outcome.deliverable === "string" &&
          run.outcome.deliverable.trim().length > 0
            ? run.outcome.deliverable
            : null) ?? run.output_text,
        rawError: run.outcome.failure?.raw_error ?? rowRawError,
        slug,
      })
    :
      renderFromParts({
        status: run.status,
        deliverableText: run.output_text,
        rawError: rowRawError,
        slug,
      });

  return reply;
}
