import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClaimHive",
  description: "Stop losing money to dental claim denials.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
