import type { Metadata } from "next";
import { Funnel_Sans } from "next/font/google";
import "./globals.css";

// Figma type styles all use Funnel Sans (400 / 500 / 600 / 700).
const funnelSans = Funnel_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-funnel-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Connection Manager | Enterprise 360",
  description: "Securely manage tenant data connections.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={funnelSans.variable}>
      <body>{children}</body>
    </html>
  );
}
