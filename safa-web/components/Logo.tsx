export default function Logo({ height = 30 }: { height?: number }) {
  // The uploaded logo, trimmed with a transparent background, lives in /public.
  return <img src="/safa-logo.png" alt="safa.ai" className="logo-img" style={{ height }} />;
}
