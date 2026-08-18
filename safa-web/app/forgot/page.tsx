"use client";
import { useState } from "react";
import Link from "next/link";
import Logo from "@/components/Logo";

export default function Forgot() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch("/api/forgot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      setSent(true);
    } catch { setSent(true); }
    setLoading(false);
  }

  return (
    <div className="au peach-bg">
      <div className="ambient" aria-hidden><span className="orb a" /><span className="orb b" /></div>
      <div className="top"><Link href="/"><Logo height={26} /></Link></div>
      <main>
        <div className="card">
          <h1 className="headline">Reset your password</h1>
          {sent ? (
            <>
              <p className="sub">If an account exists for <b>{email}</b>, we&apos;ve sent a reset link. Check your inbox (and spam).</p>
              <Link className="btn-primary" href="/login?mode=login" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>Back to log in</Link>
            </>
          ) : (
            <>
              <p className="sub">Enter your email and we&apos;ll send you a link to set a new password.</p>
              <form onSubmit={submit} noValidate>
                <div className="field">
                  <label htmlFor="email">Email</label>
                  <input id="email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <button type="submit" className="btn-primary" disabled={loading}>{loading ? "Sending…" : "Send reset link"}</button>
              </form>
              <p className="swap"><Link href="/login?mode=login" style={{ color: "var(--coral-deep)", fontWeight: 600 }}>Back to log in</Link></p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
