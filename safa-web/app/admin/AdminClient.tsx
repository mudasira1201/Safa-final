"use client";
import { useEffect, useMemo, useState } from "react";

type U = { id: string; name: string | null; email: string | null; plan: string; credits: number; isAdmin: boolean; blocked: boolean; rootAdmin: boolean; emailVerified: string | null; createdAt: string; _count: { projects: number } };
type P = { id: string; title: string; status: string; blocked: boolean; shareToken: string | null; filmUrl: string | null; createdAt: string; user: { id: string; email: string | null } | null; _count: { artifacts: number; reports: number } };
type J = { id: string; type: string; status: string; stage: string; progress: number; error: string | null; attempts: number; createdAt: string; project: { title: string; user: { email: string | null } | null } | null };
type R = { id: string; reason: string; details: string; status: string; createdAt: string; reporterEmail: string | null; project: { id: string; title: string; blocked: boolean; shareToken: string | null; user: { id: string; email: string | null; blocked: boolean } | null } | null };
type RR = { id: string; referrerEmail: string; referredEmail: string; plan: string; rewardCredits: number; status: string; createdAt: string };
type Data = { users: U[]; projects: P[]; jobs: J[]; reports: R[]; referralRewards: RR[]; stats: Record<string, number> & { qaPassRateWeek: number | null; qaUnverifiedRateWeek: number | null } };
type Confirm = { title: string; body: string; label: string; danger?: boolean; run: () => Promise<void> };
type Tab = "reports" | "referrals" | "users" | "projects" | "jobs" | "revenue" | "support";
type RevenueRow = { userId: string; email: string | null; plan: string; costUsd: number; revenueUsd: number; marginUsd: number };
type Ticket = { id: string; email: string; subject: string; message: string; status: string; createdAt: string; draftReply: string | null };

const REASON: Record<string, string> = { sexual: "Sexual content", violence: "Graphic violence", hate: "Hate speech", harassment: "Harassment", illegal: "Illegal activity", copyright: "Copyright", other: "Other" };

function ago(d: string) {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default function AdminClient() {
  const [data, setData] = useState<Data | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [tab, setTab] = useState<Tab>("reports");
  const [grant, setGrant] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [alert, setAlert] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [q, setQ] = useState("");
  const [owner, setOwner] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);
  const [revenue, setRevenue] = useState<RevenueRow[] | null>(null);
  const [revenueErr, setRevenueErr] = useState("");
  const [revenueLoading, setRevenueLoading] = useState(false);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [ticketsErr, setTicketsErr] = useState("");
  const [ticketBusy, setTicketBusy] = useState<string | null>(null);

  async function loadTickets() {
    setTicketsErr("");
    try {
      const r = await fetch("/api/admin/support-tickets", { cache: "no-store" });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setTicketsErr(d.error || `Failed to load (${r.status}).`); return; }
      const d = await r.json();
      setTickets(d.tickets);
    } catch {
      setTicketsErr("Could not reach the server.");
    }
  }

  async function ticketAction(ticketId: string, action: "draft" | "resolve") {
    setTicketBusy(ticketId);
    try {
      const r = await fetch("/api/admin/support-tickets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId, action }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setTicketsErr(d.error || "That didn't work."); }
    } finally {
      setTicketBusy(null);
      await loadTickets();
    }
  }

  // Fetched on-demand, not bundled into the main overview load() below —
  // this one makes a live Stripe API call per user with a stripeCustomerId
  // (see the route's own comment), so it's slower and shouldn't slow down
  // every ordinary page load/refresh for a tab most visits won't open.
  async function loadRevenue() {
    setRevenueLoading(true); setRevenueErr("");
    try {
      const r = await fetch("/api/admin/cost-vs-revenue", { cache: "no-store" });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setRevenueErr(d.error || `Failed to load (${r.status}).`); return; }
      const d = await r.json();
      setRevenue(d.rows);
    } catch {
      setRevenueErr("Could not reach the server.");
    } finally {
      setRevenueLoading(false);
    }
  }

  async function load() {
    try {
      const r = await fetch("/api/admin/overview", { cache: "no-store" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setLoadErr(`The dashboard could not load. The server returned ${r.status}. ${d.error || "Check the npm run dev terminal for the error."}`);
        return;
      }
      setData(await r.json());
      setLoadErr("");
    } catch {
      setLoadErr("Could not reach the server. Is it still running?");
    }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { setQ(""); }, [tab]);
  useEffect(() => { if (tab === "revenue" && revenue === null && !revenueLoading) loadRevenue(); }, [tab]);
  useEffect(() => { if (tab === "support" && tickets === null) loadTickets(); }, [tab]);

  async function post(url: string, payload: object, key: string) {
    setBusy(key); setAlert("");
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!r.ok) { const d = await r.json().catch(() => ({})); setAlert(d.error || "That didn't work."); }
    setBusy(null);
    await load();
  }

  const emails = useMemo(() => (data ? [...new Set(data.users.map((u) => u.email).filter(Boolean) as string[])] : []), [data]);

  const users = useMemo(() => {
    if (!data) return [];
    const s = q.trim().toLowerCase();
    return s ? data.users.filter((u) => `${u.email} ${u.name}`.toLowerCase().includes(s)) : data.users;
  }, [data, q]);

  const projects = useMemo(() => {
    if (!data) return [];
    const s = q.trim().toLowerCase();
    return data.projects
      .filter((p) => (owner ? p.user?.email === owner : true))
      .filter((p) => (s ? `${p.title} ${p.user?.email}`.toLowerCase().includes(s) : true));
  }, [data, q, owner]);

  const jobs = useMemo(() => {
    if (!data) return [];
    return data.jobs
      .filter((j) => (owner ? j.project?.user?.email === owner : true))
      .filter((j) => (failedOnly ? j.status === "failed" : true));
  }, [data, owner, failedOnly]);

  function askBlockUser(id: string, email: string | null, blocked: boolean, key: string) {
    setConfirm({
      title: blocked ? "Restore this account?" : "Suspend this account?",
      body: blocked
        ? `${email} will be able to sign in and generate films again. Their films stay hidden until you restore them individually.`
        : `${email} will be signed out of the API immediately, cannot log in, and EVERY film they have published goes dark at once. Use this for repeat abuse, not a single bad film.`,
      label: blocked ? "Restore account" : "Suspend account",
      danger: !blocked,
      run: () => post("/api/admin/users", { userId: id, action: blocked ? "unblock" : "block" }, key),
    });
  }

  if (loadErr) {
    return (
      <div className="adm">
        <h1>safa admin</h1>
        <p className="adm-alert">{loadErr}</p>
        <button className="adm-refresh" style={{ marginTop: 14 }} onClick={() => { setLoadErr(""); load(); }}>Try again</button>
      </div>
    );
  }
  if (!data) return <div className="adm"><h1>safa admin</h1><p className="adm-sub">Loading the dashboard</p></div>;

  const s = data.stats;
  const openReports = data.reports.filter((r) => r.status === "open");
  const closedReports = data.reports.filter((r) => r.status !== "open");
  const pendingReferrals = data.referralRewards.filter((r) => r.status === "pending");
  const reviewedReferrals = data.referralRewards.filter((r) => r.status !== "pending");

  return (
    <div className="adm">
      <div className="adm-top">
        <div>
          <h1>safa admin</h1>
          <p className="adm-sub">{s.clipsTotal} clips rendered all time. Clips are the main provider cost.</p>
        </div>
        <button className="adm-refresh" onClick={load}>Refresh</button>
      </div>

      {alert && <p className="adm-alert">{alert}</p>}

      <div className="adm-strip">
        <div className="adm-tile"><b>{s.userCount}</b><span>users</span></div>
        <div className="adm-tile"><b>{s.projectCount}</b><span>projects</span></div>
        <div className="adm-tile"><b>{s.doneCount}</b><span>films finished</span></div>
        <div className="adm-tile accent"><b>{s.clipsWeek}</b><span>clips this week</span></div>
        <div className={s.openReports ? "adm-tile danger" : "adm-tile"}><b>{s.openReports}</b><span>open reports</span></div>
        <div className={pendingReferrals.length ? "adm-tile accent" : "adm-tile"}><b>{pendingReferrals.length}</b><span>pending referrals</span></div>
        <div className={s.failedCount ? "adm-tile danger" : "adm-tile"}><b>{s.failedCount}</b><span>failed jobs</span></div>
        <div className={s.blockedUsers ? "adm-tile danger" : "adm-tile"}><b>{s.blockedUsers}</b><span>suspended</span></div>
        <div className="adm-tile accent"><b>${s.spendToday.toFixed(2)}</b><span>spend today</span></div>
        <div className="adm-tile"><b>${s.spendWeek.toFixed(2)}</b><span>spend this week</span></div>
        <div className="adm-tile"><b>${s.spendMonth.toFixed(2)}</b><span>spend this month</span></div>
        {/* Fetched by the API since PRIORITY 5 but never rendered until now
            (confirmed dead data on this page — see lib/opsDigest.ts's own
            comment). Null-safe: no QaEvent rows yet (a fresh deploy) means
            no rate to show, not a 0% that would misleadingly imply "checked
            and clean." */}
        <div className="adm-tile"><b>{s.qaPassRateWeek === null ? "—" : `${s.qaPassRateWeek}%`}</b><span>QA pass rate (7d)</span></div>
        <div className={s.qaUnverifiedRateWeek ? "adm-tile danger" : "adm-tile"}><b>{s.qaUnverifiedRateWeek === null ? "—" : `${s.qaUnverifiedRateWeek}%`}</b><span>QA unverified rate (7d)</span></div>
      </div>

      <div className="adm-tabs">
        {(["reports", "referrals", "users", "projects", "jobs", "revenue", "support"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "adm-tab on" : "adm-tab"} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
            {t === "reports" && s.openReports > 0 && <em className="adm-count">{s.openReports}</em>}
            {t === "referrals" && pendingReferrals.length > 0 && <em className="adm-count">{pendingReferrals.length}</em>}
            {t === "jobs" && s.failedCount > 0 && <em className="adm-count">{s.failedCount}</em>}
          </button>
        ))}
        <div className="adm-filters">
          {(tab === "users" || tab === "projects") && (
            <input className="adm-search" placeholder={tab === "users" ? "Search email or name" : "Search film or owner"} value={q} onChange={(e) => setQ(e.target.value)} />
          )}
          {(tab === "projects" || tab === "jobs") && (
            <select className="adm-select" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">All accounts</option>
              {emails.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          )}
          {tab === "jobs" && (
            <label className="adm-check">
              <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} /> Failed only
            </label>
          )}
        </div>
      </div>

      {tab === "reports" && (
        <>
          {openReports.length === 0 && <div className="adm-empty">Nothing to review. Reported films land here.</div>}
          {openReports.map((r) => {
            const u = r.project?.user;
            return (
              <div className="rep-row" key={r.id}>
                <div className="rep-main">
                  <div className="rep-head">
                    <strong>{r.project?.title || "Deleted project"}</strong>
                    <span className="rep-reason">{REASON[r.reason] || r.reason}</span>
                    {r.project?.blocked && <span className="rep-tag down">film down</span>}
                    {u?.blocked && <span className="rep-tag down">user suspended</span>}
                  </div>
                  {r.details && <p className="rep-details">{r.details}</p>}
                  <p className="rep-meta">
                    Reported by <b>{r.reporterEmail || "an anonymous viewer"}</b>
                    {" \u00b7 "}Owner: <b>{u?.email || "unknown"}</b>
                    {" \u00b7 "}{ago(r.createdAt)} ago
                    {r.project?.shareToken && <>{" \u00b7 "}<a href={`/p/${r.project.shareToken}`} target="_blank" rel="noreferrer">watch it</a></>}
                  </p>
                </div>
                <div className="rep-actions">
                  {!r.project?.blocked && (
                    <button className="rep-btn danger" disabled={busy === r.id} onClick={() => setConfirm({
                      title: "Take this film down?",
                      body: `"${r.project?.title}" will 404 on its public link. The owner keeps it in their account.`,
                      label: "Take it down", danger: true,
                      run: () => post("/api/admin/reports", { reportId: r.id, action: "block" }, r.id),
                    })}>Take down film</button>
                  )}
                  {u && !u.blocked && (
                    <button className="rep-btn danger" disabled={busy === r.id} onClick={() => askBlockUser(u.id, u.email, false, r.id)}>Suspend user</button>
                  )}
                  <button className="rep-btn" disabled={busy === r.id} onClick={() => setConfirm({
                    title: "Dismiss this report?",
                    body: "The film stays public and the report is marked reviewed.",
                    label: "Dismiss",
                    run: () => post("/api/admin/reports", { reportId: r.id, action: "dismiss" }, r.id),
                  })}>Dismiss</button>
                </div>
              </div>
            );
          })}

          {closedReports.length > 0 && (
            <>
              <h3 className="adm-h3">Reviewed</h3>
              {closedReports.map((r) => (
                <div className="rep-row done" key={r.id}>
                  <div className="rep-main">
                    <div className="rep-head">
                      <strong>{r.project?.title || "Deleted project"}</strong>
                      <span className="rep-reason">{REASON[r.reason] || r.reason}</span>
                      <span className={r.status === "actioned" ? "rep-tag down" : "rep-tag ok"}>{r.status === "actioned" ? "taken down" : "dismissed"}</span>
                    </div>
                    <p className="rep-meta">Reported by {r.reporterEmail || "an anonymous viewer"} {" \u00b7 "} {ago(r.createdAt)} ago</p>
                  </div>
                  <div className="rep-actions">
                    {r.project?.blocked && (
                      <button className="rep-btn" disabled={busy === r.id} onClick={() => setConfirm({
                        title: "Restore this film?", body: "Its public link will work again.", label: "Restore it",
                        run: () => post("/api/admin/reports", { reportId: r.id, action: "unblock" }, r.id),
                      })}>Restore</button>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {tab === "referrals" && (
        <>
          {pendingReferrals.length === 0 && <div className="adm-empty">Nothing to review. A reward lands here the moment a referred user completes their first paid checkout.</div>}
          {pendingReferrals.map((r) => (
            <div className="rep-row" key={r.id}>
              <div className="rep-main">
                <div className="rep-head">
                  <strong>{r.referrerEmail}</strong>
                  <span className="rep-reason">referred {r.referredEmail}</span>
                </div>
                <p className="rep-meta">
                  {r.plan} plan · {r.rewardCredits} credit{r.rewardCredits === 1 ? "" : "s"} pending · {ago(r.createdAt)} ago
                </p>
              </div>
              <div className="rep-actions">
                <button className="rep-btn" disabled={busy === r.id} onClick={() => setConfirm({
                  title: "Approve this reward?",
                  body: `${r.referrerEmail} will get ${r.rewardCredits} credit${r.rewardCredits === 1 ? "" : "s"} added to their account right away.`,
                  label: "Approve",
                  run: () => post("/api/admin/referrals", { rewardId: r.id, action: "approve" }, r.id),
                })}>Approve</button>
                <button className="rep-btn danger" disabled={busy === r.id} onClick={() => setConfirm({
                  title: "Reject this reward?",
                  body: "No credits are granted. This can't be undone from here.",
                  label: "Reject", danger: true,
                  run: () => post("/api/admin/referrals", { rewardId: r.id, action: "reject" }, r.id),
                })}>Reject</button>
              </div>
            </div>
          ))}

          {reviewedReferrals.length > 0 && (
            <>
              <h3 className="adm-h3">Reviewed</h3>
              {reviewedReferrals.map((r) => (
                <div className="rep-row done" key={r.id}>
                  <div className="rep-main">
                    <div className="rep-head">
                      <strong>{r.referrerEmail}</strong>
                      <span className="rep-reason">referred {r.referredEmail}</span>
                      <span className={r.status === "approved" ? "rep-tag ok" : "rep-tag down"}>{r.status}</span>
                    </div>
                    <p className="rep-meta">{r.plan} plan · {r.rewardCredits} credit{r.rewardCredits === 1 ? "" : "s"} · {ago(r.createdAt)} ago</p>
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {tab === "users" && (
        <div className="adm-table">
          <table>
            <thead>
              <tr><th>Account</th><th>Films</th><th>Plan</th><th>Credits</th><th>Role</th><th>Grant</th><th>Access</th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.blocked ? "row-off" : ""}>
                  <td>
                    <span className="adm-em">{u.email}</span>
                    <span className="adm-name">{u.name || "-"}</span>
                    {!u.emailVerified && <span className="adm-warn">unverified</span>}
                    {u.blocked && <span className="rep-tag down">suspended</span>}
                  </td>
                  <td>{u._count.projects}</td>
                  <td>{u.plan}</td>
                  <td>{u.credits}</td>
                  <td>
                    {u.rootAdmin ? (
                      <span className="adm-owner" title="Set in ADMIN_EMAILS">owner</span>
                    ) : (
                      <button className={u.isAdmin ? "adm-toggle on" : "adm-toggle"} disabled={busy === u.id} onClick={() => setConfirm({
                        title: u.isAdmin ? "Remove admin access?" : "Make this person an admin?",
                        body: u.isAdmin
                          ? `${u.email} will lose access to this dashboard.`
                          : `${u.email} will get FULL admin access: every user, credit grants, takedowns, deletions, and promoting other admins. Only do this for someone you trust completely.`,
                        label: u.isAdmin ? "Remove access" : "Make admin",
                        danger: !u.isAdmin,
                        run: () => post("/api/admin/users", { userId: u.id, action: u.isAdmin ? "demote" : "promote" }, u.id),
                      })}>{u.isAdmin ? "Admin" : "Make admin"}</button>
                    )}
                  </td>
                  <td>
                    <div className="adm-grant">
                      <input type="number" placeholder="+/-" value={grant[u.id] ?? ""} onChange={(e) => setGrant({ ...grant, [u.id]: e.target.value })} />
                      <button disabled={busy === u.id} onClick={() => {
                        const amount = parseInt(grant[u.id] || "0", 10);
                        if (!Number.isFinite(amount) || amount === 0) return;
                        setConfirm({
                          title: `${amount > 0 ? "Grant" : "Remove"} ${Math.abs(amount)} credit${Math.abs(amount) === 1 ? "" : "s"}?`,
                          body: `${u.email} has ${u.credits}. This makes it ${u.credits + amount}. Each credit is one film render, which costs you real provider money.`,
                          label: amount > 0 ? "Grant" : "Remove",
                          danger: amount < 0,
                          run: async () => { await post("/api/admin/credits", { userId: u.id, amount }, u.id); setGrant({ ...grant, [u.id]: "" }); },
                        });
                      }}>Apply</button>
                    </div>
                  </td>
                  <td>
                    {!u.rootAdmin && (
                      <button className={u.blocked ? "adm-toggle" : "adm-toggle off"} disabled={busy === u.id}
                        onClick={() => askBlockUser(u.id, u.email, u.blocked, u.id)}>
                        {u.blocked ? "Restore" : "Suspend"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "projects" && (
        <div className="adm-table">
          <table>
            <thead>
              <tr><th>Film</th><th>Owner</th><th>Status</th><th>Assets</th><th>Age</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className={p.blocked ? "row-off" : ""}>
                  <td>
                    <span className="adm-em">{p.title}</span>
                    {p.blocked && <span className="rep-tag down">down</span>}
                    {p._count.reports > 0 && <span className="adm-warn">{p._count.reports} report{p._count.reports === 1 ? "" : "s"}</span>}
                  </td>
                  <td>{p.user?.email || "-"}</td>
                  <td><span className={`adm-badge ${p.status === "done" ? "done" : p.status === "failed" ? "failed" : "queued"}`}>{p.status}</span></td>
                  <td>{p._count.artifacts}</td>
                  <td>{ago(p.createdAt)}</td>
                  <td>
                    <div className="adm-rowacts">
                      {p.filmUrl ? <a href={p.filmUrl} target="_blank" rel="noreferrer">watch</a> : <span className="adm-dash">-</span>}
                      <button disabled={busy === p.id} onClick={() => setConfirm({
                        title: p.blocked ? "Restore this film?" : "Take this film down?",
                        body: p.blocked ? `"${p.title}" becomes publicly viewable again.` : `"${p.title}" will 404 on its public link.`,
                        label: p.blocked ? "Restore" : "Take it down",
                        danger: !p.blocked,
                        run: () => post("/api/admin/projects", { projectId: p.id, action: p.blocked ? "unblock" : "block" }, p.id),
                      })}>{p.blocked ? "Restore" : "Take down"}</button>
                      <button className="danger" disabled={busy === p.id} onClick={() => setConfirm({
                        title: "Delete permanently?",
                        body: `"${p.title}" and all its clips, images, chat and reports are deleted from the database forever. This cannot be undone.`,
                        label: "Delete forever",
                        danger: true,
                        run: () => post("/api/admin/projects", { projectId: p.id, action: "delete" }, p.id),
                      })}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "jobs" && (
        <div className="adm-table">
          <table>
            <thead>
              <tr><th>Type</th><th>Status</th><th>Film</th><th>Account</th><th>Stage</th><th>%</th><th>Tries</th><th>Age</th><th>Error</th><th></th></tr>
            </thead>
            <tbody>
              {jobs.length === 0 && (
                <tr><td colSpan={10} className="adm-empty-cell">No jobs match these filters.</td></tr>
              )}
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.type}</td>
                  <td><span className={`adm-badge ${j.status}`}>{j.status}</span></td>
                  <td>{j.project?.title || "-"}</td>
                  <td>{j.project?.user?.email || "-"}</td>
                  <td>{j.stage}</td>
                  <td>{j.progress}</td>
                  <td>{j.attempts || 0}</td>
                  <td>{ago(j.createdAt)}</td>
                  <td className="adm-err" title={j.error || ""}>{j.error || ""}</td>
                  <td>
                    {j.status === "failed" && (
                      <button className="adm-toggle" disabled={busy === j.id} onClick={() => setConfirm({
                        title: "Retry this render?",
                        body: "It goes back in the queue. Anything already rendered is cached and reused, so you only pay for the step that failed.",
                        label: "Retry it",
                        run: () => post("/api/admin/jobs", { jobId: j.id, action: "retry" }, j.id),
                      })}>Retry</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "revenue" && (
        <div className="adm-table">
          {revenueLoading && <div className="adm-empty">Loading — this makes a live Stripe API call per paying user.</div>}
          {revenueErr && <p className="adm-alert">{revenueErr}</p>}
          {!revenueLoading && !revenueErr && (
            <table>
              <thead>
                <tr><th>Account</th><th>Plan</th><th>Cost (Spend)</th><th>Revenue (Stripe)</th><th>Margin</th></tr>
              </thead>
              <tbody>
                {revenue && revenue.length === 0 && (
                  <tr><td colSpan={5} className="adm-empty-cell">No paying customers yet.</td></tr>
                )}
                {revenue?.map((r) => (
                  <tr key={r.userId}>
                    <td>{r.email || r.userId}</td>
                    <td>{r.plan}</td>
                    <td>${r.costUsd.toFixed(2)}</td>
                    <td>${r.revenueUsd.toFixed(2)}</td>
                    <td className={r.marginUsd < 0 ? "adm-err" : ""}>${r.marginUsd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "support" && (
        <div className="adm-table">
          {ticketsErr && <p className="adm-alert">{ticketsErr}</p>}
          {tickets && tickets.length === 0 && <div className="adm-empty">No support tickets.</div>}
          {tickets?.map((t) => (
            <div className="rep-row" key={t.id}>
              <div className="rep-main">
                <div className="rep-head">
                  <strong>{t.subject}</strong>
                  <span className="rep-reason">{t.status}</span>
                </div>
                <p className="rep-details">{t.message}</p>
                <p className="rep-meta">From <b>{t.email}</b> · {ago(t.createdAt)} ago</p>
                {t.draftReply && (
                  <p className="rep-details"><em>Draft reply:</em><br />{t.draftReply}</p>
                )}
              </div>
              <div className="rep-actions">
                {t.status !== "resolved" && (
                  <>
                    <button className="rep-btn" disabled={ticketBusy === t.id} onClick={() => ticketAction(t.id, "draft")}>
                      {t.draftReply ? "Regenerate draft" : "Generate draft"}
                    </button>
                    <button className="rep-btn" disabled={ticketBusy === t.id} onClick={() => ticketAction(t.id, "resolve")}>
                      Mark resolved
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {confirm && (
        <div className="adm-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirm(null); }}>
          <div className="adm-modal" role="dialog" aria-modal="true" aria-label={confirm.title}>
            <h3>{confirm.title}</h3>
            <p>{confirm.body}</p>
            <div className="adm-modal-actions">
              <button className="rep-btn" onClick={() => setConfirm(null)}>Cancel</button>
              <button
                className={confirm.danger ? "rep-btn solid-danger" : "rep-btn solid"}
                onClick={async () => { const c = confirm; setConfirm(null); await c.run(); }}
              >{confirm.label}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}