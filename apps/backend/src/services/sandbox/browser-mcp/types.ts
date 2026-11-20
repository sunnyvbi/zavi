
export type BrowserToolCtx = {
  tenant_id: string;
  run_id: string;
  agent_slug: string;
  repo_full_name: string;
  declared_tools?: readonly string[];
  staging_origin?: string;
  read_only?: boolean;
  user_id?: string;
  engine?: "sandbox" | "anchor";
  session_key?: string;
  logged_out?: boolean;
  network_guard?: boolean;
  extension?: {
    panel_session_id: string;
    tab_id: number;
  };
  on_confirm_wait?: (waited_ms: number) => void;
};

export type ExtensionNodeRef = {
  frame_session: string | null;
  backend_node_id: number;
};

export const EXTENSION_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
] as const;
export type ExtensionKey = (typeof EXTENSION_KEYS)[number];

export const EXTENSION_MODIFIERS = ["Alt", "Control", "Meta", "Shift", "Mod"] as const;
export type ExtensionModifier = (typeof EXTENSION_MODIFIERS)[number];

export const EXTENSION_CHORD_KEYS = [
  "a", "c", "v", "x", "z", "y", "f", "Enter", "Tab", "Escape", "Delete", "Backspace",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
] as const;
export type ExtensionChordKey = (typeof EXTENSION_CHORD_KEYS)[number];

export type ExtensionShotPoint = { x: number; y: number; shot_w: number; shot_h: number };

export type ExtensionClickOpts = {
  button?: "left" | "right";
  click_count?: 1 | 2 | 3;
  modifiers?: ExtensionModifier[];
  dialog_text?: string;
};

export function browserSessionKey(ctx: Pick<BrowserToolCtx, "run_id" | "session_key">): string {
  return ctx.session_key || ctx.run_id;
}

export type DaemonOp =
  | { op: "nav"; url: string }
  | { op: "click"; selector: string }
  | { op: "fill"; selector: string; value: string }
  | { op: "text"; selector: string }
  | { op: "assert_text"; selector: string; expected: string }
  | { op: "assert_url"; expected: string }
  | { op: "screenshot"; path?: string }
  | { op: "wait_for"; selector: string; timeout_ms?: number }
  | { op: "dom_snapshot" }
  | { op: "console_errors" }
  | { op: "current_url" }
  | { op: "ax_snapshot" }
  | ({ op: "click_ref"; ref: ExtensionNodeRef } & ExtensionClickOpts)
  | { op: "type_ref"; ref: ExtensionNodeRef; text: string }
  | { op: "select_option"; ref: ExtensionNodeRef; label?: string; value?: string }
  | { op: "set_checked"; ref: ExtensionNodeRef; checked: boolean }
  | { op: "key"; key: ExtensionKey; focus_ref?: ExtensionNodeRef | null }
  | { op: "scroll"; dy: number; ref?: ExtensionNodeRef }
  | { op: "resolve"; ref: ExtensionNodeRef | null; at?: ExtensionShotPoint }
  | { op: "hover_ref"; ref: ExtensionNodeRef }
  | ({ op: "hover_xy" } & ExtensionShotPoint)
  | ({ op: "click_xy"; hit_ref?: ExtensionNodeRef | null } & ExtensionShotPoint & ExtensionClickOpts)
  | { op: "drag_ref"; ref: ExtensionNodeRef; to_ref: ExtensionNodeRef }
  | ({ op: "drag_xy"; to_x: number; to_y: number; hit_ref?: ExtensionNodeRef | null; to_hit_ref?: ExtensionNodeRef | null } & ExtensionShotPoint)
  | ({ op: "scroll_at"; dx: number; dy: number } & ExtensionShotPoint)
  | { op: "key_chord"; key: ExtensionChordKey; modifiers: ExtensionModifier[]; focus_ref?: ExtensionNodeRef | null; dialog_text?: string }
  | { op: "nav_history" }
  | { op: "history_go"; entry_id: number; url: string }
  | { op: "reload"; expect_url: string }
  | ({ op: "zoom"; w: number; h: number } & ExtensionShotPoint)
  | { op: "get_page_text"; max_chars?: number }
  | { op: "wait_until"; text?: string; text_gone?: string; network_quiet?: boolean; timeout_ms: number }
  | { op: "choose"; ref: ExtensionNodeRef; option: string }
  | { op: "page_outline"; max_chars?: number };

export type DaemonResult =
  | { ok: true; result?: unknown }
  | { ok: false; error_code: string; error_message: string };

export const ALL_BROWSER_TOOL_NAMES = [
  "browser_nav",
  "browser_click",
  "browser_fill",
  "browser_text",
  "browser_assert_text",
  "browser_assert_url",
  "browser_screenshot",
  "browser_wait_for",
] as const;

export type BrowserToolName = (typeof ALL_BROWSER_TOOL_NAMES)[number];
