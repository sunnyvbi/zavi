"use client";

import {
  buildRunPanel,
  type RunPanel as RunPanelModel,
  type RunPanelGroup,
  type RunPanelStep,
  type RunPanelThought,
  type RunPanelTool,
} from "@zavi/shared";
import { agentDisplayName } from "@/lib/agentRegistry";
import { humanizeToolName } from "@/lib/workspace/humanizeToolName";
import {
  fieldLabel,
  readCallFields,
  type CallField,
} from "@/lib/workspace/callFields";
import { splitFileRefs } from "@/lib/workspace/fileRefs";
import { FileRefChips } from "./FileRefChips";
import type { ChatRow } from "@/lib/workspace/useChatThread";

export function toActivityRows(rows: ChatRow[]) {
  return rows.map((r) => ({
    id: r.id,
    kind: String((r.body as Record<string, unknown>).teKind ?? ""),
    body: r.body as Record<string, unknown>,
  }));
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-ink/15 border-t-ink/60 animate-spin motion-reduce:animate-none"
    />
  );
}

export function Tick({ failed = false }: { failed?: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`h-3.5 w-3.5 shrink-0 ${failed ? "text-[#c0392b]" : "text-ink/40"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {failed ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="m5 12 4 4L19 6" />}
    </svg>
  );
}

function StateIcon({ state }: { state: RunPanelStep["state"] }) {
  return state === "running" ? (
    <Spinner />
  ) : (
    <Tick failed={state === "failed"} />
  );
}

function Chevron() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 shrink-0 text-ink/35 transition-transform group-open/g:rotate-180"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m7 9 5 5 5-5" />
    </svg>
  );
}

function Thought({ item }: { item: RunPanelThought }) {
  if (item.origin === "plan") {
    return <p className="py-1.5 text-[13px] leading-relaxed text-ink/55">{item.text}</p>;
  }
  return (
    <p className="py-1.5 text-[14px] leading-relaxed text-ink/85">
      {item.text}
      {item.live && (
        <span
          aria-hidden
          className="ml-0.5 inline-block h-[13px] w-[5px] translate-y-[2px] rounded-[1px] bg-ink/60 animate-pulse motion-reduce:animate-none"
        />
      )}
    </p>
  );
}

function fieldValue(key: string, value: string): string {
  if (key === "target_agent_slug" || key === "agent_slug")
    return agentDisplayName(value);
  if (key === "routed_to") return value.replace(/_/g, " ");
  return value;
}

function CallFields({ title, fields }: { title: string; fields: CallField[] }) {
  return (
    <div className="mt-2 border-t border-rule/70 pt-2 first:mt-1.5">
      <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink/40">
        {title}
      </p>
      <dl className="mt-1 space-y-1.5">
        {fields.map((field, index) => {
          const { body, files } = splitFileRefs(
            fieldValue(field.key, field.value),
          );
          return (
            <div
              key={`${field.key}:${index}`}
              className="grid grid-cols-[auto_1fr] gap-x-3"
            >
              <dt className="min-w-[72px] pt-px text-[12px] text-ink/45">
                {fieldLabel(field.key)}
              </dt>
              <dd className="min-w-0 text-[13px] leading-[1.55] text-ink/80">
                {body && (
                  <span className="whitespace-pre-wrap break-words">
                    {body}
                    {field.truncated && <span className="text-ink/40">…</span>}
                  </span>
                )}
                <FileRefChips files={files} className={body ? "mt-1.5" : ""} />
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function RawText({ arrow, text }: { arrow: string; text: string }) {
  return (
    <pre className="mb-0 mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.6] text-ink/55">
      {`${arrow} ${text}`}
    </pre>
  );
}

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[");
}

function readableFields(raw: string): CallField[] | null {
  const fields = readCallFields(raw)?.filter((f) => !looksLikeJson(f.value));
  return fields && fields.length > 0 ? fields : null;
}

export function RawCall({ tool }: { tool: RunPanelTool }) {
  const failed = tool.state === "failed";
  const input = tool.input ? readableFields(tool.input) : null;
  const output = tool.output ? readableFields(tool.output) : null;
  return (
    <div className="rounded-xl border border-rule bg-bone/40 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-ink/70">
          {humanizeToolName(tool.name)}
        </span>
        <span
          className={`ml-auto shrink-0 text-[11px] ${failed ? "text-[#c0392b]" : "text-ink/40"}`}
        >
          {tool.state === "running"
            ? "running"
            : failed
              ? "failed"
              : tool.ms > 0
                ? `${tool.ms} ms`
                : ""}
        </span>
      </div>
      {tool.input &&
        (input ? (
          <CallFields title="Request" fields={input} />
        ) : (
          !looksLikeJson(tool.input) && <RawText arrow="→" text={tool.input} />
        ))}
      {tool.output &&
        (output ? (
          <CallFields title="Result" fields={output} />
        ) : (
          !looksLikeJson(tool.output) ? (
            <RawText arrow="←" text={tool.output} />
          ) : (
            failed && <RawText arrow="←" text="This step failed." />
          )
        ))}
    </div>
  );
}

function Group({ item }: { item: RunPanelGroup }) {
  return (
    <details className="group/g">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-[13px] text-ink/60 hover:text-ink/85">
        <StateIcon state={item.state} />
        <span className="min-w-0 truncate">
          {item.label}
          {item.count > 1 && (
            <span className="text-ink/40"> ×{item.count}</span>
          )}
        </span>
        <Chevron />
      </summary>
      <div className="flex flex-col gap-2 pb-2 pt-1">
        {item.tools.map((t) => (
          <RawCall key={t.key} tool={t} />
        ))}
      </div>
    </details>
  );
}

export function RunPanel({
  rows = [],
  model,
  agentSlug,
  state = "running",
  drafting = false,
  liveThought,
  queueAhead = null,
  label,
  workingAriaLabel,
}: {
  rows?: ChatRow[];
  label?: string;
  workingAriaLabel?: string;
  model?: RunPanelModel;
  agentSlug: string;
  state?: RunPanelModel["state"];
  drafting?: boolean;
  liveThought?: string;
  queueAhead?: number | null;
}) {
  const panel =
    model ??
    buildRunPanel(toActivityRows(rows), { state, drafting, liveThought });
  if (model) state = model.state;
  const running = state === "running";
  const agentName = agentDisplayName(agentSlug);

  if (!running && !panel.items.some((i) => i.type === "group")) return null;
  if (state === "finished" && panel.readOnly === true) return null;

  const queued = typeof queueAhead === "number";
  const story = panel.items.filter((i) => i.type !== "step");
  const startingUp =
    running &&
    panel.items.every((i) => i.type === "step" && i.key !== "drafting");
  const summary =
    label ?? (queued || startingUp ? "Getting started…" : panel.summary);

  const ariaLabel = queued
    ? summary
    : running
      ? (workingAriaLabel ?? `${agentName} is working`)
      : summary;

  const line = (
    <>
      <span className="sr-only">{ariaLabel}</span>
      {state === "failed" && <Tick failed />}
      <span className="min-w-0 flex-1" aria-hidden>
        <span
          className={`block truncate ${running ? "zavi-shimmer text-[14px]" : "text-[13px] text-ink/55"}`}
        >
          {summary}
        </span>
      </span>
    </>
  );

  if (story.length === 0) {
    return (
      <div className="my-1.5 flex min-w-0 items-center gap-2 py-1">{line}</div>
    );
  }

  const spoken = running
    ? story
        .filter((i): i is RunPanelThought => i.type === "thought" && i.origin !== "plan")
        .map((t) => t.text)
    : [];

  return (
    <>
      {spoken.length > 0 && (
        <div className="sr-only">
          {spoken.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </div>
      )}
      <details
        key={running ? "live" : "settled"}
        className="group my-1.5 animate-mode-switch motion-reduce:animate-none"
      >
        <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 py-1">
          {line}
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5 shrink-0 text-ink/35 transition-transform group-open:rotate-90"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </summary>
        <div className="mt-1 border-l border-rule pl-3">
          {story.length > 0 && (
            <div>
              {story.map((item) =>
                item.type === "thought" ? (
                  <Thought key={item.key} item={item} />
                ) : item.type === "group" ? (
                  <Group key={item.key} item={item} />
                ) : null,
              )}
            </div>
          )}
        </div>
      </details>
    </>
  );
}
