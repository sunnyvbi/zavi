
import { EyeIcon, PeopleIcon, ShieldIcon, WarningIcon, ZaviMark } from "./icons";
import { openInTab } from "./open-in-tab";

import type { JSX } from "react";

type Props = {
  onAccept: () => void;
  onDecline: () => void;
  busy: boolean;
  error: string | null;
  denied?: boolean;
};

export const CONSENT_TITLE = "Zavi can work in this tab for you";

export const CONSENT_ACCEPT_LABEL = "Allow";

export const CONSENT_DECLINE_LABEL = "Not now";

export const TERMS_URL = "https://www.zaviagent.com/terms";
export const PRIVACY_URL = "https://www.zaviagent.com/privacy";

export const CONSENT_ROWS: {
  key: string;
  tone: "neutral" | "warn";
  Icon: typeof EyeIcon;
  text: string;
}[] = [
  {
    key: "acts",
    tone: "neutral",
    Icon: EyeIcon,
    text: "When you ask, Zavi clicks, types and moves around this tab using your logged-in accounts.",
  },
  {
    key: "money",
    tone: "neutral",
    Icon: ShieldIcon,
    text: "It pauses and asks before steps that clearly spend money.",
  },
  {
    key: "sends",
    tone: "neutral",
    Icon: PeopleIcon,
    text: "It sends a screenshot of the tab with each step. People at Zavi may read what you send to improve Zavi.",
  },
  {
    key: "stop",
    tone: "neutral",
    Icon: ShieldIcon,
    text: "Press Stop or close this panel at any time to stop it.",
  },
  {
    key: "hidden-instructions",
    tone: "warn",
    Icon: WarningIcon,
    text: "Pages can contain hidden instructions that try to make an AI act without you asking. Zavi treats what it reads as information, not orders, but be careful letting it work on sites you do not trust.",
  },
];

export function ConsentScreen(props: Props): JSX.Element {
  const denied = props.denied === true;

  return (
    <div className="zv-screen" role="group" aria-labelledby="zv-consent-title">
      <div className="zv-screen-body zv-consent-body">
        {}
        <ZaviMark className="zv-consent-mark" size={28} />

        <h2 className="zv-screen-title zv-consent-title" id="zv-consent-title">
          {CONSENT_TITLE}
        </h2>

        <ul className="zv-rows">
          {CONSENT_ROWS.map((row) => (
            <li
              key={row.key}
              className={row.tone === "warn" ? "zv-row zv-row-warn" : "zv-row"}
            >
              <row.Icon className="zv-row-icon" />
              <p className="zv-row-text">{row.text}</p>
            </li>
          ))}
        </ul>
      </div>

      <div className="zv-screen-actions zv-screen-actions-centered">
        <button
          type="button"
          className="zv-primary zv-primary-pill zv-consent-accept"
          onClick={props.onAccept}
          disabled={props.busy}
        >
          {props.busy
            ? "Waiting for Chrome..."
            : denied
              ? "Ask Chrome again"
              : CONSENT_ACCEPT_LABEL}
        </button>

        <button
          type="button"
          className="zv-quiet zv-consent-decline"
          onClick={props.onDecline}
          disabled={props.busy}
        >
          {CONSENT_DECLINE_LABEL}
        </button>

        {}
        <div className="zv-screen-status">
          {props.error ? (
            <p className="zv-error" role="alert">
              {props.error}
            </p>
          ) : denied ? (
            <p className="zv-denied" role="alert">
              Chrome did not grant access, so Zavi cannot take a screenshot.
              Nothing was sent and nothing was recorded. If Chrome stops asking,
              open the Extensions menu, choose Zavi, and set site access to all
              sites.
            </p>
          ) : (
            <p className="zv-hint">
              {props.busy
                ? "Chrome is asking for site access."
                : "Chrome will ask you to confirm."}
            </p>
          )}
        </div>

        <p className="zv-legal">
          By continuing you agree to the{" "}
          <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" onClick={openInTab(TERMS_URL)}>
            Terms
          </a>{" "}
          and{" "}
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" onClick={openInTab(PRIVACY_URL)}>
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </div>
  );
}
