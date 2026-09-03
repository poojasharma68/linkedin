import './globals.css';

export const metadata = { title: 'LinkedIn Posts' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
