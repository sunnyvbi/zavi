
import { STOP_BUTTON, WORKING_BAR } from "../executor/copy";

import type { JSX } from "react";

export function WorkingBar(props: { onStop: () => void }): JSX.Element {
  return (
    <div className="zv-workbar" role="status" aria-live="polite">
      <span className="zv-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="zv-workbar-text">{WORKING_BAR}</span>
      <button type="button" className="zv-workbar-stop" onClick={props.onStop}>
        {STOP_BUTTON}
      </button>
    </div>
  );
}
