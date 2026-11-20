"use client";

import { useState } from "react";
import { LaunchVideoChat } from "./LaunchVideoChat";
import { LaunchVideoForm } from "./LaunchVideoForm";

export function LaunchVideoEntry() {
  const [mode, setMode] = useState<"chat" | "form">("chat");
  if (mode === "form") {
    return (
      <div>
        <button
          type="button"
          onClick={() => setMode("chat")}
          className="mb-4 text-[13px] text-[#595959] underline underline-offset-4 hover:text-[#0e0f11]"
        >
          Rather just talk to Zavi?
        </button>
        <LaunchVideoForm />
      </div>
    );
  }
  return <LaunchVideoChat onUseForm={() => setMode("form")} />;
}
