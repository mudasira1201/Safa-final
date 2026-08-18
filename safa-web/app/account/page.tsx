"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Logo from "@/components/Logo";

type Me = { name?: string; email?: string; plan?: string; credits?: number; allotment?: number; used?: number; hasBilling?: boolean; createdAt?: string };

const planName = (p?: string) => (!p ? "…" : p === "lite" ? "Free" : p.charAt(0).toUpperCase() + p.slice(1));

export default function Account() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => {});
  }, []);

  async function manageBilling() {
    setBusy(true);
    try {
      const r = await fetch("/api/stripe/portal", { method: "POST" });
      const d = await r.json();
      if (d.url) window.location.href = d.url;
      else router.push("/pricing");
    } catch { router.push("/pricing"); }
    setBusy(false);
  }

  const allot = me?.allotment ?? 0;
  const left = me?.credits ?? 0;
  const used = me?.used ?? Math.max(0, allot - left);
  const pct = allot > 0 ? Math.min(100, Math.round((used / allot) * 100)) : 0;

  return (
    <div className="acct">
      <div className="acct-top">
        <Link href="/app"><Logo height={26} /></Link>
        <Link className="acct-back" href="/app">← Back to workspace</Link>
      </div>

      <div className="acct-wrap">
        <h1>Account &amp; billing</h1>

        {!me ? (
          <p className="acct-sub">Loading…</p>
        ) : (
          <>
            <div className="acct-card">
              <div className="acct-row"><span>Current plan</span><b className="acct-plan">{planName(me.plan)}</b></div>
              <div className="acct-meter">
                <div className="acct-meter-head"><span>{left} credits left</span><span>{used} of {allot} used</span></div>
                <div className="acct-bar"><i style={{ width: `${pct}%` }} /></div>
              </div>
              {me.plan === "lite" || !me.hasBilling ? (
                <button className="acct-btn" onClick={() => router.push("/pricing")}>Upgrade plan</button>
              ) : (
                <button className="acct-btn" onClick={manageBilling} disabled={busy}>{busy ? "Opening…" : "Manage payment & billing"}</button>
              )}
            </div>

            <div className="acct-card">
              <div className="acct-h2">Billing</div>
              <div className="acct-line"><span>Status</span><span>{me.hasBilling ? "Active subscription" : "Free plan, no billing"}</span></div>
              <div className="acct-line"><span>Payment method</span><span>{me.hasBilling ? "Managed securely via Stripe" : "—"}</span></div>
              <div className="acct-line"><span>Invoices & receipts</span><span>{me.hasBilling ? <button className="acct-link" onClick={manageBilling}>Open billing portal</button> : "—"}</span></div>
            </div>

            <div className="acct-card">
              <div className="acct-h2">Account</div>
              <div className="acct-line"><span>Name</span><span>{me.name || "—"}</span></div>
              <div className="acct-line"><span>Email</span><span>{me.email}</span></div>
              <div className="acct-line"><span>Member since</span><span>{me.createdAt ? new Date(me.createdAt).toLocaleDateString() : "—"}</span></div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}