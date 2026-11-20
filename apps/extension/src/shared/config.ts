
declare const __ZAVI_API_BASE__: string;
declare const __ZAVI_WEB_BASE__: string;
declare const __ZAVI_SUPABASE_URL__: string;
declare const __ZAVI_SUPABASE_ANON_KEY__: string;

export const API_BASE = __ZAVI_API_BASE__;
export const WEB_BASE = __ZAVI_WEB_BASE__;
export const SUPABASE_URL = __ZAVI_SUPABASE_URL__;
export const SUPABASE_ANON_KEY = __ZAVI_SUPABASE_ANON_KEY__;

export const CONNECT_URL = `${WEB_BASE}/extension/connect`;

export const AGENT_SLUG = "operator";

export const AUTH_STORAGE_KEY = "zavi-ext-auth";

export const MAX_TITLE_BYTES = 512;

export const ANSWER_POLL_MS = 2000;
export const RUN_STATUS_EVERY_N_POLLS = 3;
export const ANSWER_TIMEOUT_MS = 5 * 60 * 1000;

export const BROAD_HOST_PATTERN = "<all_urls>";

export const SCREENSHOT_MAX_EDGE = 1568;
export const SCREENSHOT_JPEG_QUALITY = 70;

export const THREAD_IDLE_POLL_MS = 6000;
export const THREAD_IDLE_POLL_WINDOW_MS = 30 * 60 * 1000;
