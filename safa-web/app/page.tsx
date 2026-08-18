import Link from "next/link";
import Logo from "@/components/Logo";

export default function Landing() {
  return (
    <div className="lp peach-bg">
      <div className="ambient" aria-hidden>
        <span className="orb a" /><span className="orb b" /><span className="orb c" />
      </div>

      <header>
        <div className="wrap">
          <div className="topbar">
            <div className="logo-left"><Logo height={30} /></div>
            <div className="brand-center" />
            <nav className="auth">
              <Link className="btn btn-ghost" href="/login?mode=login">Log in</Link>
              <Link className="btn btn-solid" href="/login?mode=signup">Sign up</Link>
            </nav>
          </div>
        </div>
      </header>

      <main>
        <div className="wrap">
          <section className="hero">
            <p className="eyebrow reveal d1">Script to screen, in one place</p>
            <h1 className="tagline">
              <span className="reveal d2">Every great story deserves to be seen.</span>
              <span className="l2 reveal d3">We are making sure nothing stops it.</span>
            </h1>
            <p className="subline reveal d4">
              Write an idea, and safa turns it into a finished, cinematic film: shot by shot,
              character by character, start to render.
            </p>
            <div className="cta-row reveal d5">
              <Link className="btn btn-solid btn-lg" href="/login?mode=signup">Get started</Link>
            </div>
            <p className="cta-note reveal d5">No crew, no cameras. Just your story.</p>
          </section>
        </div>
      </main>

      <footer>
        <div className="wrap">
          <div className="foot">
            <div className="foot-brand">
              <Logo height={28} />
              <p>An AI film studio in your browser. From script to a finished, shareable film.</p>
              <div className="socials">
                <a href="https://x.com/safa_ai" target="_blank" rel="noopener noreferrer" aria-label="X (Twitter)"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2H22l-7.5 8.6L23 22h-6.8l-5.3-6.9L4.8 22H1.7l8-9.2L1 2h7l4.8 6.3L18.9 2zm-2.4 18h1.9L7.6 4H5.6l10.9 16z"/></svg></a>
                <a href="https://instagram.com/safa.ai" target="_blank" rel="noopener noreferrer" aria-label="Instagram"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg></a>
                <a href="https://facebook.com/safa.ai" target="_blank" rel="noopener noreferrer" aria-label="Facebook"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 22v-8h2.7l.4-3h-3.1V9c0-.9.3-1.5 1.6-1.5H17V5c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.4-4 4.1v2H8v3h2.6v8h2.9z"/></svg></a>
                <a href="https://youtube.com/@safa.ai" target="_blank" rel="noopener noreferrer" aria-label="YouTube"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M23 12s0-3.2-.4-4.7c-.2-.8-.9-1.5-1.7-1.7C19.4 5.2 12 5.2 12 5.2s-7.4 0-8.9.4c-.8.2-1.5.9-1.7 1.7C1 8.8 1 12 1 12s0 3.2.4 4.7c.2.8.9 1.5 1.7 1.7 1.5.4 8.9.4 8.9.4s7.4 0 8.9-.4c.8-.2 1.5-.9 1.7-1.7.4-1.5.4-4.7.4-4.7zM9.8 15.3V8.7l5.7 3.3-5.7 3.3z"/></svg></a>
              </div>
            </div>
            <div>
              <h4>Plans</h4>
              <Link href="/pricing">Lite</Link><Link href="/pricing">Plus</Link>
              <Link href="/pricing">Pro</Link><Link href="/pricing">Enterprise</Link>
            </div>
            <div>
              <h4>Company</h4>
              <a href="mailto:mudasira1201@gmail.com">Contact us</a><a href="#">About</a><a href="#">Blog</a><a href="#">Careers</a>
            </div>
            <div>
              <h4>Legal</h4>
              <a href="#">Privacy policy</a><a href="#">Terms of service</a><a href="#">Copyright</a><a href="#">Cookie settings</a>
            </div>
          </div>
          <div className="subfoot">
            <span>© 2026 Safa. All rights reserved.</span>
            <span className="links"><a href="#">Privacy</a><a href="#">Terms</a><a href="#">Status</a></span>
          </div>
        </div>
      </footer>
    </div>
  );
}
