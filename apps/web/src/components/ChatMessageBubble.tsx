import { AgentRunProgress } from "@/components/AgentRunProgress";

export type ChatMessage = {
  id: string;
  sender_role: "user" | "assistant" | "system";
  body: string;
  agent_run_id?: string | null;
  created_at: string;
  inFlight?: boolean;
};

export function ChatMessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.sender_role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 text-[16px] leading-[1.55] whitespace-pre-wrap ${
          isUser
            ? "bg-skyMuted text-white"
            : "bg-white border border-slate-200 text-slate-800"
        }`}
      >
        <div>{msg.body || (msg.inFlight ? "…" : "")}</div>
        {msg.inFlight && msg.agent_run_id && (
          <div className="mt-2 border-t border-white/30 pt-2 text-[12px] opacity-90">
            <AgentRunProgress run_id={msg.agent_run_id} />
          </div>
        )}
        <div
          className={`mt-1 text-[11px] ${
            isUser ? "text-white/70" : "text-slate-400"
          }`}
        >
          {new Date(msg.created_at).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}
