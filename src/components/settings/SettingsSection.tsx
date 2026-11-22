import type { ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader.tsx';

/** Header + body of one settings panel; the heading id doubles as the section's aria label target. */
export default function SettingsSection({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  const headingId = `settings-${title.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <section className="w-full px-5 py-6 sm:px-8 sm:py-8" aria-labelledby={headingId}>
      <PageHeader icon={icon} title={title} titleId={headingId} description={description} className="mb-7" />
      {children}
    </section>
  );
}
