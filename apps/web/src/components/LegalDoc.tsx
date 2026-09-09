export type LegalSection = { heading: string; body: React.ReactNode };

/** Placeholder for owner-supplied legal details. Renders visibly marked so it
 *  is never mistaken for finished copy. */
export function Fill({ label }: { label: string }) {
  return (
    <mark className="bg-warn/20 text-warn font-semibold px-1 rounded">[{label} — to be completed]</mark>
  );
}

export function LegalDoc({
  title,
  sections,
}: {
  title: string;
  sections: LegalSection[];
}) {
  return (
    <article className="mx-auto max-w-3xl px-5 py-16">
      <h1 className="text-3xl font-black">{title}</h1>
      <p className="text-muted text-sm mt-2">
        Effective date: <Fill label="Effective date" />
      </p>

      <div className="mt-6 rounded-lg border border-warn/40 bg-warn/10 p-4 text-xs text-warn">
        This document is a structured template. The highlighted items must be completed and
        reviewed by the business before this page is published.
      </div>

      <div className="mt-10 space-y-8 text-sm leading-relaxed">
        {sections.map((s, i) => (
          <section key={i}>
            <h2 className="font-bold text-base mb-2">
              {i + 1}. {s.heading}
            </h2>
            <div className="text-muted space-y-2">{s.body}</div>
          </section>
        ))}
      </div>
    </article>
  );
}
