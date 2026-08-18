"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Logo from "@/components/Logo";

export default function Reset() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get("token") || ""); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (pw.length < 8) { setErr("Use at least 8 characters."); return; }
    if (pw !== confirm) { setErr("Passwords do not match."); return; }
    setLoading(true);
    try {
      const r = await fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password: pw }) });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || "Could not reset."); setLoading(false); return; }
      setDone(true);
      setTimeout(() => router.push("/login?mode=login&reset=1"), 1500);
    } catch { setErr("Something went wrong."); setLoading(false); }
  }

  return (
    <div className="au peach-bg">
      <div className="ambient" aria-hidden><span className="orb a" /><span className="orb b" /></div>
      <div className="top"><Link href="/"><Logo height={26} /></Link></div>
      <main>
        <div className="card">
          <h1 className="headline">Set a new password</h1>
          {done ? (
            <p className="sub">✓ Password updated. Taking you to log in…</p>
          ) : !token ? (
            <p className="sub">This reset link is missing its token. Request a new one from the <Link href="/forgot" style={{ color: "var(--coral-deep)", fontWeight: 600 }}>forgot password</Link> page.</p>
          ) : (
            <form onSubmit={submit} noValidate>
              <div className="field">
                <label htmlFor="pw">New password</label>
                <input id="pw" type="password" placeholder="********" value={pw} onChange={(e) => setPw(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="cf">Confirm password</label>
                <input id="cf" type="password" placeholder="********" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
              {err && <div className="notice" style={{ background: "rgba(192,57,43,.1)", borderColor: "rgba(192,57,43,.35)", color: "#a3271b", marginBottom: 14 }}>{err}</div>}
              <button type="submit" className="btn-primary" disabled={loading}>{loading ? "Saving…" : "Update password"}</button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
