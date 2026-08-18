"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import Logo from "@/components/Logo";
import CreateFlow from "@/components/CreateFlow";
import Dialog, { type DialogSpec } from "@/components/Dialog";
import { statusLabel } from "@/lib/status";

type View = "newproject" | "projects" | "artifacts" | "recents" | "project";
type Proj = { id: string; title: string; status: string; filmUrl: string | null; script?: string };
const TITLES: Record<View, string> = {
  newproject: "New project", projects: "All projects", artifacts: "Artifacts", recents: "Recents", project: "Project",
};

// Force a <video> to paint its first frame as a poster. Safari ignores #t= alone, so we
// seek on both loadedmetadata and loadeddata for reliable cross-browser thumbnails.
function seekPoster(e: React.SyntheticEvent<HTMLVideoElement>) {
  const v = e.currentTarget;
  try { if (v.currentTime < 0.05) v.currentTime = 0.1; } catch {}
}
// The worker uploads a .jpg poster next to each video (same path). Derive it here.
const posterFor = (u: string) => u.replace(/\.mp4(#.*)?$/i, ".jpg");

export default function AppShell() {
  const router = useRouter();
  const [view, setView] = useState<View>("newproject");
  const [accountOpen, setAccountOpen] = useState(false);
  const [openDots, setOpenDots] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareProject, setShareProject] = useState<{ id: string; title: string } | null>(null);
  const [shareUrl, setShareUrl] = useState("");
  const [shareLoading, setShareLoading] = useState(false);
  const [shareReady, setShareReady] = useState(true);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareGallery, setShareGallery] = useState(false);
  const [shareGalleryBusy, setShareGalleryBusy] = useState(false);
  const [modifyFor, setModifyFor] = useState<Proj | null>(null);
  const [artTab, setArtTab] = useState(0);
  const [greeting, setGreeting] = useState("Welcome");
  const [projects, setProjects] = useState<Proj[]>([]);
  const [me, setMe] = useState<{ name?: string; plan?: string; credits?: number }>({});
  const [modifyScript, setModifyScript] = useState("");
  const [artifacts, setArtifacts] = useState<{ id: string; kind: string; url: string; projectId: string }[]>([]);
  // Keys of sheet entities ("projectId:kind:entityId") with a regen_sheet job
  // just queued — purely a local "hang on, working on it" indicator; the
  // gallery itself picks up the actual new images next time it reloads
  // (switching tabs/views already calls loadArtifacts()).
  const [regeneratingSheets, setRegeneratingSheets] = useState<Set<string>>(new Set());
  // Which existing project the "project" view is resumed into — CreateFlow
  // itself now owns all the status-driven fetching/polling for it (same
  // machinery a brand-new project already used), so there's no separate
  // detail/poll state to manage here anymore.
  const [resumeProjectId, setResumeProjectId] = useState<string | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingArtifacts, setLoadingArtifacts] = useState(true);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [flowTitle, setFlowTitle] = useState("");
  const [referOpen, setReferOpen] = useState(false);
  const [referLink, setReferLink] = useState("");
  const [referLoading, setReferLoading] = useState(false);
  const [referCopied, setReferCopied] = useState(false);

  useEffect(() => {
    const h = new Date().getHours();
    setGreeting(h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
  }, []);
  // Claim any pending referral (see app/r/[code]/route.ts + api/referral/
  // claim/route.ts) once per app load. Fully idempotent server-side -- a
  // no-op the instant referredBy is already set or there's no ref cookie --
  // so there's no need to detect "this is a brand-new signup" here at all.
  useEffect(() => {
    fetch("/api/referral/claim", { method: "POST" }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!accountOpen && openDots === null) return;
    const close = () => { setAccountOpen(false); setOpenDots(null); };
    // attach on the next tick so the click that opened the menu doesn't immediately close it
    const id = window.setTimeout(() => document.addEventListener("click", close), 0);
    return () => { window.clearTimeout(id); document.removeEventListener("click", close); };
  }, [accountOpen, openDots]);
  useEffect(() => { fetch("/api/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => d && setMe(d)).catch(() => {}); }, []);
  const loadProjects = () => fetch("/api/projects", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { projects: [] })).then((d) => setProjects(d.projects || [])).catch(() => {}).finally(() => setLoadingProjects(false));
  // CONFIRMED REAL GAP, FIXED: regeneratingSheets only ever got cleared on a
  // FAILED regen (see regenSheet() below) — on success it stayed in the Set
  // forever, since nothing else was clearing it, so that entity's
  // "Regenerate" button would show "Regenerating…" and stay disabled
  // permanently, even after the real job finished and a page reload showed
  // the new sheet. Clearing it here means the indicator now resets exactly
  // when it says it will ("the gallery itself picks up the actual new images
  // next time it reloads") — a possible-but-harmless side effect is clearing
  // it slightly before an in-flight job truly finishes if the tab is
  // switched away and back quickly, which just re-enables the button a
  // little early; the server's own duplicate-request guard (sheets/route.ts)
  // still rejects a genuine double-submission either way.
  const loadArtifacts = () => fetch("/api/artifacts", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { artifacts: [] })).then((d) => { setArtifacts(d.artifacts || []); setRegeneratingSheets(new Set()); }).catch(() => {}).finally(() => setLoadingArtifacts(false));
  useEffect(() => { loadProjects(); loadArtifacts(); }, []);

  const go = (v: View) => { setView(v); setAccountOpen(false); setOpenDots(null); if (v === "artifacts") loadArtifacts(); else if (v !== "newproject") loadProjects(); };
  function deleteProject(id: string) {
    setDialog({
      title: "Delete this project?",
      body: "The project, its clips, and its final film will be removed. This cannot be undone.",
      confirmLabel: "Delete project",
      danger: true,
      onConfirm: async () => {
        await fetch(`/api/projects/${id}`, { method: "DELETE" });
        setProjects((ps) => ps.filter((p) => p.id !== id));
      },
    });
  }
  function renameProject(p: Proj) {
    setDialog({
      title: "Rename project",
      placeholder: "Project name",
      defaultValue: p.title,
      confirmLabel: "Rename",
      onConfirm: async (title) => {
        if (!title) return;
        await fetch(`/api/projects/${p.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
        setProjects((ps) => ps.map((x) => (x.id === p.id ? { ...x, title } : x)));
      },
    });
  }
  // Ask for a fresh take on ONE character/prop/location reference sheet.
  // Only location_sheet takes a note — its generation step (runLocationSheet)
  // is the one that actually reads it and folds it into the new canonical
  // image; a note typed for a character or prop sheet would currently be
  // silently ignored by the worker, so those stay a plain confirm (no input)
  // rather than offer a box that does nothing.
  function regenSheet(entity: { projectId: string; kind: string; entityId: string; label: string }) {
    const key = `${entity.projectId}:${entity.kind}:${entity.entityId}`;
    const takesNote = entity.kind === "location_sheet";
    setDialog({
      title: `Regenerate this ${entity.label}?`,
      body: takesNote
        ? "Describe what should change, or leave it blank for a fresh take. This won't cost a credit."
        : "We'll design a fresh reference sheet. This won't cost a credit.",
      ...(takesNote ? { placeholder: "e.g. make it a rustic wooden cabin instead of a modern loft" } : {}),
      confirmLabel: "Regenerate",
      allowEmpty: true,
      onConfirm: async (note) => {
        setRegeneratingSheets((s) => new Set(s).add(key));
        try {
          const r = await fetch(`/api/projects/${entity.projectId}/sheets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "regenSheet", sheetKind: entity.kind, entityId: entity.entityId, note: takesNote ? note : "" }),
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            setDialog({ title: "Couldn't start regeneration", body: d.error || "Please try again.", confirmLabel: "OK", onConfirm: () => {} });
            setRegeneratingSheets((s) => { const n = new Set(s); n.delete(key); return n; });
          }
        } catch {
          setRegeneratingSheets((s) => { const n = new Set(s); n.delete(key); return n; });
        }
      },
    });
  }
  // "Modify" asks WHAT to change first. Editing the script starts a fresh film (a new
  // generation, a new credit); editing the clips keeps this film and tweaks shots via chat.
  function modifyProject(p: Proj) { setOpenDots(null); setModifyFor(p); }
  function modifyTheScript(p: Proj) { setModifyFor(null); setModifyScript(p.script || " "); setView("newproject"); }
  function modifyTheClips(p: Proj) { setModifyFor(null); openProject(p.id); }
  function openProject(id: string) {
    setOpenDots(null); setAccountOpen(false); setFlowTitle(""); setView("project"); setResumeProjectId(id);
  }
  async function openShare(p: { id: string; title: string }) {
    setOpenDots(null);
    setShareProject(p); setShareOpen(true); setShareUrl(""); setShareCopied(false); setShareLoading(true); setShareReady(true); setShareGallery(false);
    try {
      const r = await fetch(`/api/projects/${p.id}/share`, { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j?.token) throw new Error("no token");
      setShareUrl(`${window.location.origin}/p/${j.token}`);
      setShareReady(!!j.ready);
      setShareGallery(!!j.publicGallery);
    } catch {
      setShareUrl("");
    } finally {
      setShareLoading(false);
    }
  }
  async function copyShare() {
    if (!shareUrl) return;
    try { await navigator.clipboard.writeText(shareUrl); setShareCopied(true); setTimeout(() => setShareCopied(false), 2000); } catch {}
  }
  async function openRefer() {
    setAccountOpen(false);
    setReferOpen(true); setReferCopied(false); setReferLoading(true);
    try {
      const r = await fetch("/api/referral/me");
      const j = await r.json();
      setReferLink(j?.link || "");
    } catch {
      setReferLink("");
    } finally {
      setReferLoading(false);
    }
  }
  async function copyRefer() {
    if (!referLink) return;
    try { await navigator.clipboard.writeText(referLink); setReferCopied(true); setTimeout(() => setReferCopied(false), 2000); } catch {}
  }
  async function toggleGallery(enable: boolean) {
    if (!shareProject) return;
    setShareGalleryBusy(true);
    setShareGallery(enable); // optimistic
    try {
      const r = await fetch(`/api/projects/${shareProject.id}/gallery`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enable }),
      });
      const j = await r.json();
      if (!r.ok) { setShareGallery(!enable); return; } // revert on failure (e.g. not done rendering yet)
      setShareGallery(!!j.publicGallery);
    } catch {
      setShareGallery(!enable);
    } finally {
      setShareGalleryBusy(false);
    }
  }
  function newProject() { setModifyScript(""); setFlowTitle(""); go("newproject"); }

  const firstName = me.name?.split(" ")[0] || "there";
  const initial = (me.name?.[0] || "U").toUpperCase();
  const planLabel = me.plan ? (me.plan === "lite" ? "Free plan" : me.plan.charAt(0).toUpperCase() + me.plan.slice(1) + " plan") : "…";

  const ProjectCard = ({ p }: { p: Proj }) => (
    <div className="pcard">
      <div className="dots">
        <button className="dots-btn" aria-label={`Options for ${p.title}`} onClick={(e) => { e.stopPropagation(); setOpenDots(openDots === p.id ? null : p.id); setAccountOpen(false); }}>⋯</button>
        {openDots === p.id && (
          <div className="dots-menu">
            <button onClick={() => modifyProject(p)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>Modify</button>
            <button onClick={() => openShare(p)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></svg>Share</button>
            <button onClick={() => renameProject(p)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 20h16" /><path d="M4 20v-4L14 6l4 4L8 20H4Z" /></svg>Rename</button>
            {p.filmUrl && <button onClick={() => window.open(p.filmUrl!, "_blank")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 5v14l11-7L8 5z" /></svg>Open film</button>}
            <button className="danger" onClick={() => deleteProject(p.id)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>Delete</button>
          </div>
        )}
      </div>
      <div className="thumb" style={{ cursor: "pointer" }} onClick={() => openProject(p.id)}>
        {p.filmUrl
          ? <video src={`${p.filmUrl}#t=0.1`} poster={posterFor(p.filmUrl)} muted playsInline preload="metadata" onLoadedMetadata={seekPoster} onLoadedData={seekPoster} />
          : <span className="thumb-ph"><span className="tph-1">In progress</span><span className="tph-2">Not completed yet</span></span>}
      </div>
      <div className="body" style={{ cursor: "pointer" }} onClick={() => openProject(p.id)}><div className="t">{p.title}</div><div className="m">{statusLabel(p.status)}</div></div>
    </div>
  );

  return (
    <div className="as">
      <aside className="sidebar">
        <div className="s-logo"><Logo height={26} /></div>
        <button className="new-btn" onClick={newProject}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>New project
        </button>
        <div className="s-scroll">
        <nav className="nav">
          <button className={`nav-item ${view === "projects" ? "active" : ""}`} onClick={() => go("projects")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /></svg>All projects
          </button>
          <button className={`nav-item ${view === "artifacts" ? "active" : ""}`} onClick={() => go("artifacts")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5h16v14H4z" /><path d="m4 15 4-4 3 3 5-5 4 4" /></svg>Artifacts
          </button>
          <button className={`nav-item ${view === "recents" ? "active" : ""}`} onClick={() => go("recents")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>Recents
          </button>
        </nav>
        <div className="nav-label">Recent projects</div>
        <div className="recent-list">
          {projects.map((p) => (
            <div className="recent-item" key={p.id}>
              <button className="recent-name" onClick={() => openProject(p.id)}>{p.title}</button>
              <button
                className="recent-dots"
                aria-label={`Options for ${p.title}`}
                onClick={(e) => { e.stopPropagation(); setOpenDots(openDots === `r-${p.id}` ? null : `r-${p.id}`); setAccountOpen(false); }}
              >⋯</button>
              {openDots === `r-${p.id}` && (
                <div className="dots-menu recent-menu">
                  <button onClick={() => renameProject(p)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 20h16" /><path d="M4 20v-4L14 6l4 4L8 20H4Z" /></svg>Rename</button>
                  <button onClick={() => openShare(p)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></svg>Share</button>
                  <button className="danger" onClick={() => deleteProject(p.id)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>Delete</button>
                </div>
              )}
            </div>
          ))}
        </div>
        </div>
        <div className="account">
          <button className="account-btn" onClick={(e) => { e.stopPropagation(); setAccountOpen(!accountOpen); setOpenDots(null); }}>
            <span className="avatar">{initial}</span>
            <span className="account-meta"><span className="nm">{me.name || "Your account"}</span><span className="pl">{planLabel}</span></span>
            <span className="account-caret"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 15 6-6 6 6" /></svg></span>
          </button>
          {accountOpen && (
            <div className="account-menu">
              <div className="plan-pill">You&apos;re on the <b>{planLabel}</b> with {me.credits ?? 0} render credits left.</div>
              <button className="mi" onClick={() => router.push("/account")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><path d="M19.4 13a7.8 7.8 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.8 7.8 0 0 0-1.7-1L15 3H9l-.4 2.6a7.8 7.8 0 0 0-1.7 1l-2.3-1-2 3.4L4.6 11a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.8 7.8 0 0 0 1.7 1L9 21h6l.4-2.6a7.8 7.8 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5Z" /></svg>Account settings</button>
              <button className="mi" onClick={() => router.push("/account")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>Billing &amp; plan</button>
              <button className="mi" onClick={() => router.push("/pricing")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m12 3 2.5 5 5.5.8-4 3.9.9 5.5L12 21l-4.9 2.6.9-5.5-4-3.9 5.5-.8Z" /></svg>Upgrade plan</button>
              <button className="mi" onClick={openRefer}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.5-7 8-7s8 3 8 7" /></svg>Refer a friend</button>
              <div className="sep" />
              <button className="mi" onClick={() => router.push("/support")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 4.8.9c0 1.7-2.3 2.1-2.3 3.6" /><path d="M12 17h.01" /></svg>Get help</button>
              <button className="mi danger" onClick={() => signOut({ callbackUrl: "/" })}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></svg>Log out</button>
            </div>
          )}
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <span className="view-title">
            {view === "newproject" || view === "project" ? (flowTitle || TITLES[view]) : TITLES[view]}
          </span>
          {view === "project" && resumeProjectId && (
            <button className="tb-btn" onClick={() => openShare({ id: resumeProjectId, title: flowTitle || "Project" })}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></svg>Share</button>
          )}
        </div>

        <div className="content">
          {view === "newproject" && <CreateFlow key={modifyScript || "new"} greeting={greeting} firstName={firstName} initialScript={modifyScript.trim() ? modifyScript : ""} onTitle={setFlowTitle} />}
          {view === "project" && resumeProjectId && (
            <CreateFlow key={resumeProjectId} greeting={greeting} firstName={firstName} resumeProjectId={resumeProjectId} onTitle={setFlowTitle} onExit={() => go("projects")} />
          )}

          {view === "projects" && (
            <div className="fadein">
              <div className="section-h">All projects</div>
              <div className="section-sub">Everything you&apos;ve created.</div>
              {loadingProjects
                ? <div className="grid">{[0, 1, 2].map((i) => <div key={i} className="sk sk-card" />)}</div>
                : projects.length === 0
                  ? <div className="empty">No projects yet. Hit <b>New project</b> to make your first film.</div>
                  : <div className="grid">{projects.map((p) => <ProjectCard key={p.id} p={p} />)}</div>}
            </div>
          )}

          {view === "artifacts" && (() => {
            const KINDS = ["character", "image", "clip", "final", "character_sheet", "prop_sheet", "location_sheet"];
            const TAB_LABELS = ["Characters", "Images", "Clips", "Videos", "Character sheets", "Prop sheets", "Locations"];
            const EMPTY_LABELS = ["characters", "images", "clips", "final videos", "character sheets", "prop sheets", "location sheets"];
            const kind = KINDS[artTab];
            const isSheetTab = kind === "character_sheet" || kind === "prop_sheet" || kind === "location_sheet";
            const sheetLabel = kind === "character_sheet" ? "character sheet" : kind === "prop_sheet" ? "prop sheet" : "location sheet";
            const urlKindSegment = kind === "character_sheet" ? "character-sheet" : kind === "prop_sheet" ? "prop-sheet" : "location-sheet";
            const shown = artifacts.filter((a) => a.kind === kind);
            // Sheet kinds bank one Artifact row PER ANGLE IMAGE, all under the
            // same entity — group them so the gallery shows one card per
            // character/prop/location (with its first angle as the thumbnail)
            // instead of a wall of near-duplicate angle shots.
            const sheetEntities = isSheetTab
              ? (() => {
                  const map = new Map<string, { entityId: string; projectId: string; thumb: string; angle: number; count: number }>();
                  const re = new RegExp(`/${urlKindSegment}/([^/]+)/angle-(\\d+)\\.`);
                  for (const a of shown) {
                    const m = a.url.match(re);
                    if (!m) continue;
                    const entityId = m[1];
                    const angle = parseInt(m[2], 10);
                    const key = `${a.projectId}:${entityId}`;
                    const existing = map.get(key);
                    if (!existing) map.set(key, { entityId, projectId: a.projectId, thumb: a.url, angle, count: 1 });
                    else { existing.count++; if (angle < existing.angle) { existing.angle = angle; existing.thumb = a.url; } }
                  }
                  return Array.from(map.values());
                })()
              : [];
            const empty = isSheetTab ? sheetEntities.length === 0 : shown.length === 0;
            return (
              <>
                <div className="section-h">Artifacts</div>
                <div className="section-sub">Every character, image, clip, and final video generated in your projects.</div>
                <div className="a-tabs">
                  {TAB_LABELS.map((t, i) => (
                    <button key={t} className={artTab === i ? "on" : ""} onClick={() => setArtTab(i)}>{t}</button>
                  ))}
                </div>
                {loadingArtifacts ? (
                  <div className="a-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="sk sk-tile" />)}</div>
                ) : empty ? (
                  <div className="empty">Nothing here yet. Generated {EMPTY_LABELS[artTab]} will appear as your films render.</div>
                ) : isSheetTab ? (
                  <div className="a-grid">
                    {sheetEntities.map((e) => {
                      const key = `${e.projectId}:${kind}:${e.entityId}`;
                      const busy = regeneratingSheets.has(key);
                      return (
                        <div className="a-cell a-sheet" key={key}>
                          <a href={e.thumb} target="_blank" rel="noopener noreferrer">
                            <img src={e.thumb} alt="" />
                          </a>
                          {e.count > 1 && <span className="a-badge">{e.count} angles</span>}
                          <button
                            type="button"
                            className="a-regen"
                            disabled={busy}
                            onClick={() => regenSheet({ projectId: e.projectId, kind, entityId: e.entityId, label: sheetLabel })}
                          >
                            {busy ? "Regenerating…" : "Regenerate"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="a-grid">
                    {shown.map((a) => (
                      <a className="a-cell" key={a.id} href={a.url} target="_blank" rel="noopener noreferrer">
                        {a.kind === "character" || a.kind === "image"
                          ? <img src={a.url} alt="" />
                          : <video src={`${a.url}#t=0.1`} poster={posterFor(a.url)} muted playsInline preload="metadata" onLoadedMetadata={seekPoster} onLoadedData={seekPoster} />}
                      </a>
                    ))}
                  </div>
                )}
              </>
            );
          })()}

          {view === "recents" && (
            <div className="fadein">
              <div className="section-h">Recents</div>
              <div className="section-sub">Pick up where you left off.</div>
              {loadingProjects
                ? <div className="grid">{[0, 1, 2].map((i) => <div key={i} className="sk sk-card" />)}</div>
                : projects.length === 0
                  ? <div className="empty">Nothing yet.</div>
                  : <div className="grid">{projects.slice(0, 8).map((p) => <ProjectCard key={p.id} p={p} />)}</div>}
            </div>
          )}

        </div>
      </div>

      {modifyFor && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setModifyFor(null); }}>
          <div className="modal dlg" role="dialog" aria-modal="true" aria-label="Modify project">
            <button className="modal-close" onClick={() => setModifyFor(null)} aria-label="Close">×</button>
            <h3>What do you want to change?</h3>
            <p className="msub">{modifyFor.title}</p>
            <div className="mod-choices">
              <button className="mod-choice" onClick={() => modifyTheScript(modifyFor)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 20h16" /><path d="M4 20v-4L14 6l4 4L8 20H4Z" /></svg>
                <span className="mc-t">Edit the script</span>
                <span className="mc-s">Rewrite the story, then generate a new film. Your current film is kept as it is. Uses a credit.</span>
              </button>
              <button className="mod-choice" onClick={() => modifyTheClips(modifyFor)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9.5v5l4-2.5-4-2.5Z" /></svg>
                <span className="mc-t">Edit the clips</span>
                <span className="mc-s">Keep this film and change individual shots by chatting with safa. Single clip tweaks are free.</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {shareOpen && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setShareOpen(false); }}>
          <div className="modal dlg" role="dialog" aria-modal="true" aria-label="Share project">
            <button className="modal-close" onClick={() => setShareOpen(false)} aria-label="Close">×</button>
            <h3>Share {shareProject?.title ? `"${shareProject.title}"` : "your film"}</h3>
            <p className="msub">Anyone with this link can watch your finished film. No account needed.</p>
            {shareLoading ? (
              <div className="share-row"><div className="sk sk-line" style={{ flex: 1, height: 20 }} /></div>
            ) : shareUrl ? (
              <>
                <div className="share-row">
                  <input className="share-url" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Public share link" />
                  <button className="dlg-btn primary" onClick={copyShare}>{shareCopied ? "Copied" : "Copy"}</button>
                </div>
                {!shareReady && <p className="share-note">Your film is still rendering. The link will play it as soon as it is ready.</p>}
                <label className="swtch-wrap" style={{ marginTop: 14 }}>
                  <span className="swtch-lbl">List in public gallery</span>
                  <input
                    type="checkbox"
                    className="swtch-input"
                    checked={shareGallery}
                    disabled={!shareReady || shareGalleryBusy}
                    onChange={(e) => toggleGallery(e.target.checked)}
                    aria-label="List in public gallery"
                  />
                  <span className="swtch" aria-hidden="true" />
                </label>
                <p className="share-note">
                  {shareReady
                    ? "Anyone can browse this film on safa.ai/gallery — no link needed. Turn off any time."
                    : "Finish rendering to publish this to the gallery."}
                </p>
              </>
            ) : (
              <p className="msub">Could not create a share link just now. Please try again.</p>
            )}
            <div className="dlg-actions">
              <button className="dlg-btn" onClick={() => setShareOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {referOpen && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setReferOpen(false); }}>
          <div className="modal dlg" role="dialog" aria-modal="true" aria-label="Refer a friend">
            <button className="modal-close" onClick={() => setReferOpen(false)} aria-label="Close">×</button>
            <h3>Refer a friend</h3>
            <p className="msub">When someone signs up with your link and subscribes, you get credits — reviewed and added to your account within a couple of days.</p>
            {referLoading ? (
              <div className="share-row"><div className="sk sk-line" style={{ flex: 1, height: 20 }} /></div>
            ) : referLink ? (
              <div className="share-row">
                <input className="share-url" readOnly value={referLink} onFocus={(e) => e.currentTarget.select()} aria-label="Your referral link" />
                <button className="dlg-btn primary" onClick={copyRefer}>{referCopied ? "Copied" : "Copy"}</button>
              </div>
            ) : (
              <p className="msub">Could not create your referral link just now. Please try again.</p>
            )}
            <div className="dlg-actions">
              <button className="dlg-btn" onClick={() => setReferOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      <Dialog spec={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}