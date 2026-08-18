"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import Logo from "@/components/Logo";

const Check = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7" /></svg>
);

export default function Pricing() {
  const [annual, setAnnual] = useState(false);
  const [busy, setBusy] = useState("");
  const { data: session } = useSession();
  const router = useRouter();
  const price = (m: string, a: string) => (annual ? a : m);
  const billed = annual ? "Billed annually" : "Billed monthly";

  async function choose(plan: string) {
    if (!session) { router.push("/login"); return; }
    if (plan === "enterprise") { window.location.href = "mailto:mudasira1201@gmail.com?subject=safa.ai%20Enterprise%20enquiry"; return; }
    setBusy(plan);
    try {
      const r = await fetch("/api/stripe/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan }) });
      const d = await r.json();
      if (d.url) window.location.href = d.url;
      else { alert(d.error || "Could not start checkout."); setBusy(""); }
    } catch { alert("Could not start checkout."); setBusy(""); }
  }

  return (
    <div className="pr peach-bg">
      <div className="ambient" aria-hidden><span className="orb a" /><span className="orb b" /></div>

      <header>
        <div className="wrap topbar">
          <Link href="/"><Logo height={28} /></Link>
          <nav className="auth">
            {session ? (
              <Link className="btn btn-solid" href="/app">Open app</Link>
            ) : (
              <>
                <Link className="btn btn-ghost" href="/login?mode=login">Log in</Link>
                <Link className="btn btn-solid" href="/login?mode=signup">Sign up</Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <div className="wrap">
        <section className="hero">
          <h1>Pick the plan for your story</h1>
          <p>Start free. Upgrade when your films get bigger, longer, and sharper.</p>
          <div className="toggle">
            <button className={!annual ? "on" : ""} onClick={() => setAnnual(false)}>Monthly</button>
            <button className={annual ? "on" : ""} onClick={() => setAnnual(true)}>Annual</button>
            <span className="save-badge">Save 20%</span>
          </div>
        </section>

        <section className="cards">
          <div className="card">
            <div className="plan-name">Lite</div>
            <div className="plan-tag">For trying safa and making your first short films.</div>
            <div className="price"><span className="amt">Free</span></div>
            <div className="billed">Forever</div>
            <Link className="btn btn-outline" href="/login?mode=signup">Get started</Link>
            <ul className="features">
              <li><Check />3 films per month</li><li><Check />720p, up to 30-second films</li>
              <li><Check />1 character per project</li><li><Check />safa watermark</li><li><Check />Community support</li>
            </ul>
          </div>

          <div className="card">
            <div className="plan-name">Plus</div>
            <div className="plan-tag">For hobbyists making films regularly.</div>
            <div className="price"><span className="amt">{price("$12", "$10")}</span><span className="per">/mo</span></div>
            <div className="billed">{billed}</div>
            <button className="btn btn-outline" onClick={() => choose("plus")} disabled={busy === "plus"}>{busy === "plus" ? "…" : "Choose Plus"}</button>
            <ul className="features">
              <li><Check />15 films per month</li><li><Check />720p, up to 1-minute films</li>
              <li><Check />Up to 3 characters</li><li><Check />No watermark</li><li><Check />Email support</li>
            </ul>
          </div>

          <div className="card pop">
            <div className="pop-badge">Most popular</div>
            <div className="plan-name">Pro</div>
            <div className="plan-tag">For creators who publish serious work.</div>
            <div className="price"><span className="amt">{price("$29", "$23")}</span><span className="per">/mo</span></div>
            <div className="billed">{billed}</div>
            <button className="btn btn-solid" onClick={() => choose("pro")} disabled={busy === "pro"}>{busy === "pro" ? "…" : "Choose Pro"}</button>
            <ul className="features">
              <li className="head">Everything in Plus, plus</li>
              <li><Check />60 films per month</li><li><Check />720p, up to 3-minute films</li>
              <li><Check />Unlimited characters</li><li><Check />Priority rendering queue</li>
              <li><Check />Commercial usage rights</li><li><Check />Priority support</li>
            </ul>
          </div>

          <div className="card">
            <div className="plan-name">Enterprise</div>
            <div className="plan-tag">For studios and teams at scale.</div>
            <div className="price"><span className="amt">Custom</span></div>
            <div className="billed">Tailored to your team</div>
            <button className="btn btn-outline" onClick={() => choose("enterprise")}>Contact sales</button>
            <ul className="features">
              <li className="head">Everything in Pro, plus</li>
              <li><Check />Custom / unlimited volume</li><li><Check />Up to 4K films</li>
              <li><Check />API access</li><li><Check />Team seats &amp; SSO</li><li><Check />Dedicated manager &amp; SLA</li>
            </ul>
          </div>
        </section>

        <p className="reassure">Cancel anytime · No hidden fees · Every plan includes safa&apos;s full create flow.</p>
        <p className="note"><b>Note:</b> prices/limits are placeholders. Set your real numbers against your generation cost. Paid buttons use Stripe test mode until you add live keys and real Price IDs.</p>
      </div>

      <footer>
        <div className="wrap foot">
          <span>© 2026 Safa. All rights reserved.</span>
          <span className="links"><Link href="/">Home</Link><a href="#">Privacy</a><a href="#">Terms</a><a href="#">Contact</a></span>
        </div>
      </footer>
    </div>
  );
}