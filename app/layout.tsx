import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dream Journey",
  description: "A journey into AI dreams, generated with Midjourney",
  keywords: ["AI", "Midjourney", "dreams", "art", "generative art", "interactive", "zoom"],
  authors: [{ name: "Dream Journey" }],
  creator: "Dream Journey",
  publisher: "Dream Journey",
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  ...(process.env.NEXT_PUBLIC_BASE_URL && {
    metadataBase: new URL(process.env.NEXT_PUBLIC_BASE_URL),
  }),
  openGraph: {
    title: "Dream Journey",
    description: "A journey into AI dreams, generated with Midjourney",
    type: "website",
    locale: "en_US",
    siteName: "Dream Journey",
  },
  twitter: {
    card: "summary_large_image",
    title: "Dream Journey",
    description: "A journey into AI dreams, generated with Midjourney",
  },
  icons: {
    icon: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-black">{children}</body>
    </html>
  );
}
