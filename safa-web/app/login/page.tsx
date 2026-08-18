"use client";
import { useState, useEffect } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import Logo from "@/components/Logo";

type Mode = "signup" | "login";
type Errs = Partial<Record<"name" | "email" | "password" | "confirm", string>>;

export default function Auth() {
  const [mode, setMode] = useState<Mode>("signup");
  const [showPw, setShowPw] = useState(false);
  const [showCf, setShowCf] = useState(false);
  const [errs, setErrs] = useState<Errs>({});
  const [authError, setAuthError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  function switchMode(m: Mode) { setMode(m); setErrs({}); setAuthError(""); }

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const m = q.get("mode");
    if (m === "login" || m === "signup") setMode(m);
    if (q.get("verified") === "1") setInfo("Email confirmed. You can now log in.");
    else if (q.get("verified") === "0") setInfo("That confirmation link was invalid or expired.");
    else if (q.get("reset") === "1") setInfo("Password updated. Log in with your new password.");
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAuthError("");
    const er: Errs = {};
    if (mode === "signup" && !form.name.trim()) er.name = "Please enter your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) er.email = "Enter a valid email address.";
    if (form.password.length < 8) er.password = "Use at least 8 characters.";
    if (mode === "signup" && form.confirm !== form.password) er.confirm = "Passwords do not match.";
    setErrs(er);
    if (Object.keys(er).length) return;

    setLoading(true);
    try {
      if (mode === "signup") {
        const res = await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: form.name, email: form.email, password: form.password }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setAuthError(d.error || "Could not create the account.");
          setLoading(false);
          return;
        }
        // Account created. Do NOT auto-login: the email must be confirmed first.
        setMode("login");
        setErrs({});
        setAuthError("");
        setForm({ name: "", email: form.email, password: "", confirm: "" });
        setInfo("Account created. We sent a confirmation link to your email. Click it, then log in here.");
        setLoading(false);
        return;
      }
      // login mode
      const result = await signIn("credentials", {
        email: form.email,
        password: form.password,
        redirect: false,
      });
      if (result?.error) {
        setAuthError("Invalid email or password. If you just signed up, confirm your email first (check your inbox for the link).");
        setLoading(false);
        return;
      }
      // hard navigation so the workspace reloads with the freshly logged-in session
      window.location.href = "/app";
    } catch {
      setAuthError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  async function resendVerification() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setAuthError("Enter your email above first, then tap resend.");
      return;
    }
    setAuthError("");
    await fetch("/api/verify/resend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: form.email }) }).catch(() => {});
    setInfo("If that email needs confirming, we've sent a fresh link. Check your inbox.");
  }

  return (
    <div className="au peach-bg">
      <div className="ambient" aria-hidden><span className="orb a" /><span className="orb b" /></div>

      <div className="top"><Link href="/"><Logo height={26} /></Link></div>

      <main>
        <div className="card">
          <h1 className="headline">{mode === "signup" ? "Create your account" : "Welcome back"}</h1>
          <p className="sub">{mode === "signup" ? "Start turning your ideas into films." : "Log in to pick up where you left off."}</p>

          <div className="tabs" role="tablist">
            <button className={`tab ${mode === "signup" ? "active" : ""}`} onClick={() => switchMode("signup")}>Sign up</button>
            <button className={`tab ${mode === "login" ? "active" : ""}`} onClick={() => switchMode("login")}>Log in</button>
          </div>

          <form onSubmit={submit} noValidate>
            {mode === "signup" && (
              <div className="field">
                <label htmlFor="name">Full name</label>
                <input id="name" type="text" autoComplete="name" placeholder="Your name" value={form.name} onChange={set("name")} />
                <div className="err">{errs.name}</div>
              </div>
            )}

            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" autoComplete="email" placeholder="you@example.com" value={form.email} onChange={set("email")} />
              <div className="err">{errs.email}</div>
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <div className="pw-wrap">
                <input id="password" type={showPw ? "text" : "password"} placeholder="********" value={form.password} onChange={set("password")} />
                <button type="button" className="pw-toggle" onClick={() => setShowPw(!showPw)}>{showPw ? "Hide" : "Show"}</button>
              </div>
              <div className="err">{errs.password}</div>
            </div>

            {mode === "signup" && (
              <div className="field">
                <label htmlFor="confirm">Confirm password</label>
                <div className="pw-wrap">
                  <input id="confirm" type={showCf ? "text" : "password"} placeholder="********" value={form.confirm} onChange={set("confirm")} />
                  <button type="button" className="pw-toggle" onClick={() => setShowCf(!showCf)}>{showCf ? "Hide" : "Show"}</button>
                </div>
                <div className="err">{errs.confirm}</div>
              </div>
            )}

            {mode === "login" && <div className="row-end"><a className="link" href="/forgot">Forgot password?</a></div>}

            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? "Please wait..." : mode === "signup" ? "Create account" : "Log in"}
            </button>
          </form>

          <div className="divider">or</div>
          <button className="btn-google" onClick={() => signIn("google", { callbackUrl: "/app" })}>
            <svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.3 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.1-3.8 6.5-9.4 6.5-16z"/><path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.7-2.9-.7-4.4s.3-3 .7-4.4l-7.8-6.1C.9 16.9 0 20.3 0 24s.9 7.1 2.6 10.2l7.8-5.5z"/><path fill="#34A853" d="M24 48c6.2 0 11.5-2 15.3-5.6l-7.1-5.5c-2 1.4-4.6 2.2-8.2 2.2-6.4 0-11.7-3.8-13.6-9.3l-7.8 5.5C6.5 42.6 14.6 48 24 48z"/></svg>
            {mode === "signup" ? "Sign up with Google" : "Log in with Google"}
          </button>

          {info && <div className="notice" style={{ background: "rgba(46,160,67,.12)", borderColor: "rgba(46,160,67,.35)", color: "#1a7f37" }}>{info}</div>}
          {authError && <div className="notice" style={{ background: "rgba(192,57,43,.1)", borderColor: "rgba(192,57,43,.35)", color: "#a3271b" }}>{authError}</div>}

          {mode === "login" && (
            <p className="swap" style={{ marginTop: 8 }}>
              Didn&apos;t get the confirmation email? <button onClick={resendVerification}>Resend it</button>
            </p>
          )}

          <p className="swap">
            {mode === "signup" ? (
              <>Already have an account? <button onClick={() => switchMode("login")}>Log in</button></>
            ) : (
              <>New here? <button onClick={() => switchMode("signup")}>Sign up</button></>
            )}
          </p>
          <p className="terms">By continuing, you agree to our <a href="#">Terms</a> and <a href="#">Privacy Policy</a>.</p>
        </div>
      </main>
    </div>
  );
}