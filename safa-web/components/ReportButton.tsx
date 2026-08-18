// ==========================================================
// PUT THIS FILE AT:  safa-web/components/ReportButton.tsx   *** NEW FILE - create it ***
// (rename to: ReportButton.tsx)
// ==========================================================
"use client";
import { useState } from "react";

const REASONS: { id: string; label: string }[] = [
  { id: "sexual", label: "Sexual content" },
  { id: "violence", label: "Graphic violence" },
  { id: "hate", label: "Hate speech" },
  { id: "harassment", label: "Harassment" },
  { id: "illegal", label: "Illegal activity" },
  { id: "copyright", label: "Copyright" },
  { id: "other", label: "Something else" },
];

export default function ReportButton({ token }: { token: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!reason || busy) return;
    setBusy(true);
    await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, reason, details }),
    }).catch(() => {});
    setBusy(false);
    setSent(true);
  }

  return (
    <>
      <button className="rp-link" onClick={() => setOpen(true)}>Report this film</button>

      {open && (
        <div className="rp-overlay" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="rp-modal" role="dialog" aria-modal="true" aria-label="Report this film">
            {sent ? (
              <>
                <h3>Thanks for telling us</h3>
                <p className="rp-sub">We&apos;ve received your report and will review this film.</p>
                <div className="rp-actions"><button className="rp-btn primary" onClick={() => setOpen(false)}>Close</button></div>
              </>
            ) : (
              <>
                <h3>Report this film</h3>
                <p className="rp-sub">Tell us what&apos;s wrong with it. We review every report.</p>
                <div className="rp-reasons">
                  {REASONS.map((r) => (
                    <button key={r.id} className={reason === r.id ? "rp-reason on" : "rp-reason"} onClick={() => setReason(r.id)}>
                      {r.label}
                    </button>
                  ))}
                </div>
                <textarea className="rp-details" placeholder="Any more detail (optional)" value={details} maxLength={1000}
                  onChange={(e) => setDetails(e.target.value)} />
                <div className="rp-actions">
                  <button className="rp-btn" onClick={() => setOpen(false)}>Cancel</button>
                  <button className="rp-btn primary" onClick={submit} disabled={!reason || busy}>
                    {busy ? "Sending" : "Send report"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}