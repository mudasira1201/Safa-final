"use client";
import { useEffect, useRef, useState } from "react";
import { statusLabel, statusWorking } from "@/lib/status";

type Msg = { id: string; role: string; content: string };
type PendingMsg = { id: string; content: string; failed?: boolean };

// Persistent chat, embedded in the same single-column flow as whatever phase
// screen is showing (CreateFlow renders this alongside renderPhase()) — NOT
// a pinned side panel. Talks to the existing, unchanged chat route; every
// intent it already supports (continue/resume, "redo clip 3", a whole-film
// note) keeps working exactly as it did in the old sidebar.
export default function ChatPanel({ projectId, status, onActed }: { projectId: string; status: string; onActed: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [pendingMsgs, setPendingMsgs] = useState<PendingMsg[]>([]);
  const [typing, setTyping] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMessages([]); setPendingMsgs([]); setTyping(false); setChatInput("");
    fetch(`/api/projects/${projectId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.messages) setMessages(d.messages); })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages.length, pendingMsgs.length, typing]);

  async function sendChat(retry?: PendingMsg) {
    const text = retry ? retry.content : chatInput.trim();
    if (!text || chatBusy) return;
    const tempId = retry ? retry.id : `tmp-${Date.now()}`;
    if (retry) setPendingMsgs((p) => p.map((m) => (m.id === tempId ? { ...m, failed: false } : m)));
    else { setPendingMsgs((p) => [...p, { id: tempId, content: text }]); setChatInput(""); }
    setChatBusy(true); setTyping(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.messages) throw new Error("send failed");
      setMessages(j.messages);
      setPendingMsgs((p) => p.filter((m) => m.id !== tempId));
      if (j.acted) onActed(); // a job was queued — CreateFlow's resume() picks up the new status
    } catch {
      setPendingMsgs((p) => p.map((m) => (m.id === tempId ? { ...m, failed: true } : m)));
    } finally {
      setTyping(false); setChatBusy(false);
    }
  }

  const working = statusWorking(status);

  return (
    <div className="cf-chat-wrap fadein">
      <div className="pd-h">Edit with chat</div>
      <div className="section-sub">Tell safa what to change, like &quot;make clip 2 nighttime&quot; or &quot;make the whole film brighter&quot;.</div>
      <div className="pd-chat">
        {messages.length === 0 && pendingMsgs.length === 0 && (
          <div className="pd-chat-empty">No messages yet. Ask for a change below.</div>
        )}
        {messages.map((mm) => (
          <div key={mm.id} className={`pd-msg ${mm.role}`}>{mm.content}</div>
        ))}
        {pendingMsgs.map((m) => (
          <div key={m.id} style={{ display: "contents" }}>
            <div className={`pd-msg user ${m.failed ? "failed" : "pending"}`}>{m.content}</div>
            {m.failed && (
              <div className="pd-fail-row">
                <span>Not delivered.</span>
                <button onClick={() => sendChat(m)}>Retry</button>
              </div>
            )}
          </div>
        ))}
        {typing && <div className="pd-msg assistant pd-typing" aria-label="safa is replying"><i /><i /><i /></div>}
        {working && <div className="pd-msg assistant pd-working"><span className="pd-spin" />{statusLabel(status)}</div>}
        <div ref={chatEndRef} />
      </div>
      <div className="pd-chat-input">
        <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }} placeholder="Describe a change" disabled={chatBusy || working} aria-label="Describe a change" />
        <button onClick={() => sendChat()} disabled={chatBusy || working || !chatInput.trim()}>Send</button>
      </div>
    </div>
  );
}
