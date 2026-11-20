
import { CameraIcon, NewThreadIcon, SettingsIcon, ZaviMark } from "./icons";

import type { JSX } from "react";

type Props = {
  liveTitle: string | null;
  onNewThread: () => void;
  onOpenSettings: () => void;
};

export function Header(props: Props): JSX.Element {
  return (
    <header className="zv-header">
      <div className="zv-header-row">
        <span className="zv-wordmark">
          <ZaviMark size={18} />
          <span className="zv-brand">Zavi</span>
        </span>
        <div className="zv-header-actions">
          <button
            type="button"
            className="zv-icon-btn"
            onClick={props.onNewThread}
            title="Start a new thread"
            aria-label="Start a new thread"
          >
            <NewThreadIcon />
          </button>
          <button
            type="button"
            className="zv-icon-btn"
            onClick={props.onOpenSettings}
            title="Settings"
            aria-label="Settings"
          >
            <SettingsIcon />
          </button>
        </div>
      </div>
      {}
      <p
        className="zv-reading"
        title={
          props.liveTitle
            ? `Send includes a screenshot of: ${props.liveTitle}`
            : "Send includes a screenshot of the tab you are on."
        }
      >
        <span className="zv-reading-chip">
          <CameraIcon />
          {}
          <span className="zv-reading-kind">Screenshot</span>
          <span className="zv-reading-what">
            {props.liveTitle ?? "the tab you are on"}
          </span>
        </span>
      </p>
    </header>
  );
}
