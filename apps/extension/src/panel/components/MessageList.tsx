import { useEffect, useRef, useState, type JSX } from "react";
import type { ChatMessage, Decision, ProgressItem } from "../api";
import { ApprovalCard } from "./ApprovalCard";
import { Markup } from "./Markup";
import { CheckIcon, CopyIcon, ZaviMark } from "./icons";
import { STOPPED_BY_YOU } from "../executor/copy";

export type TurnPhase = "checking" | "capturing" | "thinking" | "working";

type Props = {
  messages: ChatMessage[];
  pending: string | null;
  phase: TurnPhase | null;
  steps: ProgressItem[];
  approvals: Decision[];
  getToken: () => Promise<string>;
  onDecided: () => void;
  tabSteps?: { lines: string[]; working: boolean; stopped: boolean };
};

export function MessageList(props: Props): JSX.Element {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [props.messages.length, props.pending, props.phase, props.approvals.length]);

  const empty = props.messages.length === 0 && !props.pending;

  return (
    <div className="zv-thread">
      {}
      {empty && (
        <div className="zv-empty">
          <ZaviMark className="zv-empty-mark" size={32} />
          <p className="zv-empty-line">Ask about the tab you&apos;re on.</p>
        </div>
      )}
      {props.messages.map((m) => (
        <Bubble key={m.id} role={m.sender_role} body={m.body} />
      ))}
      {props.pending && <Bubble role="user" body={props.pending} />}
      {props.approvals.map((d) => (
        <ApprovalCard
          key={d.id}
          decision={d}
          getToken={props.getToken}
          onDecided={props.onDecided}
        />
      ))}
      {props.tabSteps && <TabSteps {...props.tabSteps} />}
      {props.phase && <Waiting phase={props.phase} steps={props.steps} />}
      <div ref={endRef} />
    </div>
  );
}

function TabSteps(props: { lines: string[]; working: boolean; stopped: boolean }): JSX.Element | null {
  if (!props.working && !props.stopped) return null;
  if (props.lines.length === 0 && !props.stopped) return null;
  return (
    <div className="zv-tabsteps" aria-live="polite">
      {props.stopped && <p className="zv-tabsteps-note">{STOPPED_BY_YOU}</p>}
      {props.lines.length > 0 && (
        <ul className="zv-steps">
          {props.lines.map((line, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={i} className="zv-step zv-step-done">
              <span className="zv-step-tick" aria-hidden="true">
                {"\u2713"}
              </span>
              <span className="zv-step-label">{line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function phaseLine(phase: TurnPhase): string {
  if (phase === "checking") return "Getting ready";
  if (phase === "capturing") return "Taking a screenshot";
  if (phase === "working") return "Still working";
  return "Zavi is working";
}

function Waiting(props: { phase: TurnPhase; steps: ProgressItem[] }): JSX.Element {
  return (
    <div className="zv-wait" aria-live="polite">
      {props.steps.length > 0 && (
        <ul className="zv-steps">
          {props.steps.map((s) =>
            s.type === "thought" ? (
              <li key={s.key} className={s.origin === "plan" ? "zv-thought zv-thought-plan" : "zv-thought"}>
                {s.text}
              </li>
            ) : (
              <li key={s.key} className={`zv-step zv-step-${s.state}`}>
                <span className="zv-step-tick" aria-hidden="true">
                  {s.state === "done" ? "\u2713" : s.state === "failed" ? "\u00d7" : "\u203a"}
                </span>
                <span className="zv-step-label">
                  {s.label}
                  {s.type === "group" && s.count > 1 && ` \u00d7${s.count}`}
                  {}
                  {s.state === "failed" && <span className="zv-step-note"> — could not read</span>}
                  {}
                </span>
              </li>
            ),
          )}
        </ul>
      )}
      <p className="zv-thinking">
        <span className="zv-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {phaseLine(props.phase)}
      </p>
      {}
      <div className="zv-skel" style={{ width: "92%" }} />
      <div className="zv-skel" style={{ width: "78%" }} />
      <div className="zv-skel" style={{ width: "85%" }} />
    </div>
  );
}

function Bubble(props: { role: string; body: string }): JSX.Element {
  const mine = props.role === "user";
  return (
    <div className={mine ? "zv-msg zv-msg-user" : "zv-msg zv-msg-agent"}>
      <span className="zv-msg-who">{mine ? "You" : "Zavi"}</span>
      {}
      {mine ? (
        <span className="zv-msg-body">{props.body}</span>
      ) : (
        <div className="zv-msg-body">
          <Markup text={props.body} />
        </div>
      )}
      {!mine && <CopyReply text={props.body} />}
    </div>
  );
}

function CopyReply(props: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="zv-msg-copy"
      aria-label={copied ? "Copied" : "Copy reply"}
      title={copied ? "Copied" : "Copy"}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(props.text)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
