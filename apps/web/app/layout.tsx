import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'meeting-prd',
  description: 'Meeting transcript to PRD to ClickUp tickets, with Slack approval in between.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          {children}
          <footer className="foot">
            meeting-prd · Calendar → Vexa → Groq → Slack → ClickUp ·{' '}
            <a href="https://github.com/yashp2303/meeting-prd">source</a>
          </footer>
        </div>
      </body>
    </html>
  );
}
