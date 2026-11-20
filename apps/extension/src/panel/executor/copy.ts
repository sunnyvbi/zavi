
import type { ExtOp } from "./ops";

export const WORKING_BAR = "Zavi is working in this tab";
export const STOP_BUTTON = "Stop";
export const STOPPED_BY_YOU = "Stopped. Here's what I did before you stopped me:";
export const STOPPED_PANEL_CLOSED = "Stopped because the Zavi panel was closed.";
export const STOPPED_STEP_CAP = "I stopped after 60 steps. Here's where I got to:";
export const DAILY_TASK_CAP = "You've used today's 50 tab tasks. They reset at midnight UTC.";
export function stoppedOffSite(domain: string): string {
  return `I stopped because the next step would leave ${domain}.`;
}

const MAX_LINE_TEXT = 60;

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_LINE_TEXT ? `${t.slice(0, MAX_LINE_TEXT - 1)}…` : t;
}

export function stepLine(
  op: ExtOp,
  ctx: { targetName?: string | null; pageTitle?: string | null },
): string | null {
  switch (op.op) {
    case "nav": {
      const title = ctx.pageTitle ? clip(ctx.pageTitle) : "";
      if (title) return `Opened ${title}`;
      try {
        return `Opened ${new URL(op.url).hostname}`;
      } catch {
        return "Opened a page";
      }
    }
    case "click_ref":
      return ctx.targetName ? `Clicked ${clip(ctx.targetName)}` : "Clicked";
    case "type_ref":
      return `Typed ${clip(op.text)}`;
    case "select_option":
      return `Typed ${clip(op.label ?? op.value ?? "")}`;
    case "set_checked":
      return ctx.targetName ? `Clicked ${clip(ctx.targetName)}` : "Clicked";
    case "key":
      return `Pressed ${op.key}`;
    case "scroll":
      return op.dy < 0 ? "Scrolled up" : "Scrolled down";
    case "click_xy":
      return "Clicked";
    case "choose":
      return `Clicked ${clip(op.option)}`;
    case "key_chord":
      return `Pressed ${[...op.modifiers, op.key].join("+")}`;
    case "scroll_at":
      return op.dy < 0 ? "Scrolled up" : "Scrolled down";
    case "history_go":
    case "reload":
      return "Opened a page";
    case "drag_ref":
    case "drag_xy":
      return "Dragged";
    default:
      return null;
  }
}
