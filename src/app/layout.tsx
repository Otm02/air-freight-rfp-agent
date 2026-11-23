import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AeroBid AI — Air Freight RFP Automation Workbench",
  description:
    "Consulting-grade air freight RFP automation combining deterministic routing and financial accounting with schema-validated AI agents and human-in-the-loop checkpoints.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
