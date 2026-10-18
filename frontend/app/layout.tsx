import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SafeBrowser — Remote Browser Control',
  description: 'Control a headless Chromium instance remotely from your browser.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
