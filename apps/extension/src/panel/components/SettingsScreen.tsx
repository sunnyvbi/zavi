
import { useState, type JSX } from "react";

type Props = {
  onConfirmTurnOff: () => void;
  onClose: () => void;
  onSignOut: () => void;
  busy: boolean;
  error: string | null;
  turnedOff: boolean;
  clearedCount: number | null;
};

export function turnedOffLine(clearedCount: number | null): string {
  if (clearedCount === null) return "Page reading is off.";
  if (clearedCount === 0) {
    return "Page reading is off. There was no page content stored to erase.";
  }
  const noun = clearedCount === 1 ? "question" : "questions";
  return `Page reading is off. Zavi erased the page content from ${clearedCount} ${noun}.`;
}

export function SettingsScreen(props: Props): JSX.Element {
  return (
    <div className="zv-settings" role="group" aria-labelledby="zv-settings-title">
      <h2 className="zv-settings-title" id="zv-settings-title">
        Settings
      </h2>

      <section className="zv-settings-section">
        <h3 className="zv-settings-heading">Reading pages</h3>
        <p className="zv-settings-copy">
          When you press Send, Zavi takes a screenshot of the tab you are on and
          sends it with your message.
        </p>

        {props.turnedOff ? (
          <p className="zv-settings-done" role="status">
            {turnedOffLine(props.clearedCount)}
          </p>
        ) : (
          <TurnOffControl
            onConfirmTurnOff={props.onConfirmTurnOff}
            busy={props.busy}
          />
        )}

        {props.error && (
          <p className="zv-error" role="alert">
            {props.error}
          </p>
        )}
      </section>

      <section className="zv-settings-section">
        <h3 className="zv-settings-heading">Your account</h3>
        <button
          type="button"
          className="zv-settings-signout"
          onClick={props.onSignOut}
          disabled={props.busy}
        >
          Sign out
        </button>
      </section>

      <button
        type="button"
        className="zv-settings-back"
        onClick={props.onClose}
        disabled={props.busy}
      >
        Back to the conversation
      </button>
    </div>
  );
}

function TurnOffControl(props: {
  onConfirmTurnOff: () => void;
  busy: boolean;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <>
        <p className="zv-settings-copy">
          Turn this off and Zavi stops taking screenshots. This deletes your
          screenshots and the page details Zavi stored for you.
        </p>
        <button
          type="button"
          className="zv-settings-danger"
          onClick={() => setConfirming(true)}
          disabled={props.busy}
        >
          Turn off page reading
        </button>
      </>
    );
  }

  return (
    <div className="zv-settings-confirm-box">
      <p className="zv-settings-confirm-ask">Turn off page reading?</p>
      <p className="zv-settings-copy">
        Zavi will stop taking screenshots and delete your screenshots and the
        page details it stored for you. This cannot be undone.
      </p>
      <button
        type="button"
        className="zv-settings-confirm"
        onClick={props.onConfirmTurnOff}
        disabled={props.busy}
      >
        {props.busy ? "Turning it off..." : "Yes, turn it off"}
      </button>
      <button
        type="button"
        className="zv-settings-cancel"
        onClick={() => setConfirming(false)}
        disabled={props.busy}
      >
        Keep it on
      </button>
    </div>
  );
}
