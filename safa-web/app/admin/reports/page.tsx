// ==========================================================
// PUT THIS FILE AT:  safa-web/app/admin/reports/page.tsx   *** NEW FILE - create it ***
// (rename to: page.tsx)
// ==========================================================
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

type Report = {
  id: string; reason: string; details: string; status: string; createdAt: string;
  project: { id: string; title: string; blocked: boolean; shareToken: string | null; status: string; user: { email: string | null } | null } | null;
};

export default function AdminReports() {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const r = await fetch("/api/admin/reports");
    if (r.status === 403) { setForbidden(true); return; }
    const d = await r.json();
    setReports(d.reports || []);
  }
  useEffect(() => { load(); }, []);

  async function act(reportId: string, action: "block" | "unblock" | "dismiss") {
    setBusy(reportId);
    await fetch("/api/admin/reports", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportId, action }),
    }).catch(() => {});
    setBusy(null);
    load();
  }

  if (forbidden) return <div className="adm"><h1>Reports</h1><p className="adm-sub">You don&apos;t have access to this page.</p></div>;
  if (!reports) return <div className="adm"><h1>Reports</h1><p className="adm-sub">Loading</p></div>;

  const open = reports.filter((r) => r.status === "open");
  const closed = reports.filter((r) => r.status !== "open");

  return (
    <div className="adm">
      <h1>Reported films</h1>
      <p className="adm-sub"><Link href="/admin">Back to admin</Link></p>

      <h2>Open ({open.length})</h2>
      {open.length === 0 && <p className="adm-sub">Nothing to review.</p>}
      {open.map((r) => (
        <div key={r.id} className="rep-row">
          <div className="rep-main">
            <strong>{r.project?.title || "Deleted project"}</strong>
            <span className="rep-reason">{r.reason}</span>
            {r.project?.blocked && <span className="rep-blocked">blocked</span>}
            {r.details && <p className="rep-details">{r.details}</p>}
            <p className="rep-meta">
              {r.project?.user?.email || "unknown"} · {new Date(r.createdAt).toLocaleString()}
              {r.project?.shareToken && <> · <a href={`/p/${r.project.shareToken}`} target="_blank" rel="noreferrer">view film</a></>}
            </p>
          </div>
          <div className="rep-actions">
            <button className="rep-btn danger" disabled={busy === r.id} onClick={() => act(r.id, "block")}>Take down</button>
            <button className="rep-btn" disabled={busy === r.id} onClick={() => act(r.id, "dismiss")}>Dismiss</button>
          </div>
        </div>
      ))}

      <h2>Reviewed ({closed.length})</h2>
      {closed.map((r) => (
        <div key={r.id} className="rep-row done">
          <div className="rep-main">
            <strong>{r.project?.title || "Deleted project"}</strong>
            <span className="rep-reason">{r.reason}</span>
            <span className={r.status === "actioned" ? "rep-blocked" : "rep-ok"}>{r.status}</span>
          </div>
          <div className="rep-actions">
            {r.project?.blocked && (
              <button className="rep-btn" disabled={busy === r.id} onClick={() => act(r.id, "unblock")}>Restore</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}