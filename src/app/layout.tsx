import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "AeroBid · Air Freight RFP Desk",
  description:
    "RFP response desk for custom air freight. Deterministic routing and pricing math, schema-checked LLM extraction, and a human sign-off at every commercial decision.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen bg-canvas text-zinc-900 antialiased">
        {children}
      </body>
    </html>
  );
}
