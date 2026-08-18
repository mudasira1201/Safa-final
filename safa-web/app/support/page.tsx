"use client";
import { useState } from "react";
import Link from "next/link";
import Logo from "@/components/Logo";

export default function Support() {
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");

  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && message.trim().length >= 10;

  async function send() {
    if (busy || !valid) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, subject, message }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setErr(d.error || "That didn't send. Please try again.");
        return;
      }
      setSent(true);
    } catch {
      setErr("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="sup-page">
      <header className="sup-top">
        <Link href="/"><Logo height={26} /></Link>
        <Link href="/app" className="sup-backlink">Back to safa.ai</Link>
      </header>

      <div className="sup-main">
        <div className="sup-card">
          {sent ? (
            <div className="sup-done">
              <div className="sup-tick">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 13 4 4L19 7" /></svg>
              </div>
              <h1>We&apos;ve got it</h1>
              <p>
                Thanks for writing in. We&apos;ll reply to <b>{email}</b> as soon as we can, usually within a day.
              </p>
              <Link href="/app" className="sup-btn">Back to your projects</Link>
            </div>
          ) : (
            <>
              <h1>Get help</h1>
              <p className="sup-lead">
                Something broken, a film that went wrong, a billing question, or you need your rendering limit
                raised. Tell us what happened and we&apos;ll come back to you.
              </p>

              <div className="sup-field">
                <label htmlFor="sup-email">Your email</label>
                <input id="sup-email" type="email" autoComplete="email" placeholder="you@example.com"
                  value={email} onChange={(e) => setEmail(e.target.value)} />
                <span className="sup-hint">So we can reply.</span>
              </div>

              <div className="sup-field">
                <label htmlFor="sup-subject">Subject <em>optional</em></label>
                <input id="sup-subject" placeholder="What is this about?" maxLength={120}
                  value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>

              <div className="sup-field">
                <label htmlFor="sup-message">What happened</label>
                <textarea id="sup-message" maxLength={4000} value={message}
                  placeholder="Include the film's title if it's about a specific render. The more detail, the faster we can fix it."
                  onChange={(e) => setMessage(e.target.value)} />
                <span className="sup-hint">
                  {message.trim().length < 10
                    ? "A sentence or two is plenty."
                    : `${message.length.toLocaleString()} / 4,000 characters`}
                </span>
              </div>

              {err && <p className="sup-err">{err}</p>}

              <button className="sup-btn" onClick={send} disabled={busy || !valid}>
                {busy ? <><span className="sup-spin" />Sending</> : "Send message"}
              </button>

              <p className="sup-foot">
                You can also email us directly at <a href="mailto:support@safa.ai">support@safa.ai</a>.
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}