import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Long Zoom",
  description:
    "Interactively zoom through layered image worlds: street scenes, animals, and faces.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
