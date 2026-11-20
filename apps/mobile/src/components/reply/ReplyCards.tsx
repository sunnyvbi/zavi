import type { ReplyCard } from "../../features/agents/replyCards";
import { BuildConfirmCard } from "./BuildConfirmCard";
import { ClarifyCard } from "./ClarifyCard";
import { CodeChangeCard } from "./CodeChangeCard";
import { ConnectorRequestCard } from "./ConnectorRequestCard";
import { CustomAgentDraftCard } from "./CustomAgentDraftCard";
import { EnvelopeCard, ProposalCards } from "./EnvelopeCards";
import { HtmlPreviewCard } from "./HtmlPreviewCard";
import { LiveAppCard } from "./LiveAppCard";
import { ScheduleChip } from "./ScheduleChip";
import { SetupCard } from "./SetupCard";
import { SharedPages } from "./SharedPages";
import { SuggestionChips } from "./SuggestionChips";
import { RuleSuggestionCard } from "./RuleSuggestionCard";

export type ReplyCardActions = {
  onQuickReply?: (text: string) => Promise<boolean>;
  onRunStarted?: (runId: string) => void;
  threadId?: string;
  busy?: boolean;
  claimRun?: () => boolean;
  releaseRun?: () => void;
  onPrefill?: (text: string, placeholderHint?: string) => void;
};

export function ReplyCards({ cards, actions }: { cards: ReplyCard[]; actions: ReplyCardActions }) {
  return (
    <>
      {cards.map((card, i) => {
        switch (card.kind) {
          case "suggestions":
            return <SuggestionChips key={i} suggestions={card.suggestions} onSend={actions.onQuickReply} />;
          case "buildConfirm":
            return (
              <BuildConfirmCard
                key={card.confirm.nonce}
                confirm={card.confirm}
                threadId={actions.threadId}
                busy={actions.busy}
                claimRun={actions.claimRun}
                releaseRun={actions.releaseRun}
                onRunStarted={actions.onRunStarted}
                onPrefill={actions.onPrefill}
              />
            );
          case "schedule":
            return <ScheduleChip key={i} slug={card.slug} />;
          case "connectorRequest":
            return (
              <ConnectorRequestCard
                key={card.request.request_id}
                request={card.request}
                busy={actions.busy}
                claimRun={actions.claimRun}
                releaseRun={actions.releaseRun}
                onRunStarted={actions.onRunStarted}
              />
            );
          case "setup":
            return <SetupCard key={i} slug={card.slug} model={card.model} busy={actions.busy} claimRun={actions.claimRun} releaseRun={actions.releaseRun} onRunStarted={actions.onRunStarted} />;
          case "htmlPreview":
            return (
              <HtmlPreviewCard
                key={i}
                model={card.model}
                onQuickReply={actions.onQuickReply}
                onPrefill={actions.onPrefill}
              />
            );
          case "clarify":
            return <ClarifyCard key={i} slug={card.slug} model={card.model} busy={actions.busy} claimRun={actions.claimRun} releaseRun={actions.releaseRun} onRunStarted={actions.onRunStarted} />;
          case "envelope":
            return <EnvelopeCard key={i} outline={card.outline} />;
          case "proposals":
            return <ProposalCards key={i} proposals={card.proposals} />;
          case "sharedPages":
            return <SharedPages key={i} runId={card.runId} />;
          case "liveApp":
            return <LiveAppCard key={i} runId={card.runId} />;
          case "ruleSuggestion":
            return <RuleSuggestionCard key={card.rule_id} model={card} />;
          case "customAgent":
            return <CustomAgentDraftCard key={card.originRunId ?? i} card={card.card} originRunId={card.originRunId} />;
          case "codeChange":
            return (
              <CodeChangeCard
                key={i}
                model={card.model}
                actionable={card.actionable}
                busy={actions.busy}
                onQuickReply={actions.onQuickReply}
                onPrefill={actions.onPrefill}
              />
            );
        }
      })}
    </>
  );
}
