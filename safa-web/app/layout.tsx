// ==========================================================
// PUT THIS FILE AT:  safa-web/app/layout.tsx
// (rename to: layout.tsx)
// ==========================================================
import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Bricolage_Grotesque, Inter } from "next/font/google";
import Providers from "@/components/Providers";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});
const ui = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ui",
  display: "swap",
});

export const metadata: Metadata = {
  title: "safa.ai · Every great story deserves to be seen",
  description: "An AI film studio in your browser. From script to a finished, shareable film.",
  icons: { icon: "/safa-symbol.png", shortcut: "/safa-symbol.png", apple: "/safa-symbol.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable}`}>
      <body><Providers>{children}</Providers>  <Analytics />
  <SpeedInsights />
</body>
    </html>
  );
}