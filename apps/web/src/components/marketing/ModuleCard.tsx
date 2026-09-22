import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { ArrowRight } from 'lucide-react';

export function ModuleCard({
  icon: Icon,
  title,
  description,
  href,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  href?: string;
}) {
  const body = (
    <>
      <div className="grid h-10 w-10 place-items-center rounded-xl bg-black/5 text-black transition-colors group-hover:bg-black group-hover:text-white">
        <Icon size={19} strokeWidth={2} />
      </div>
      <div className="font-display font-bold text-[15px] mt-3.5">{title}</div>
      <p className="text-muted text-[13px] mt-1 leading-relaxed">{description}</p>
      {href && (
        <span className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-black opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0">
          Learn more <ArrowRight size={12} />
        </span>
      )}
    </>
  );

  const className =
    'group rounded-2xl border border-border bg-surface p-5 transition-all hover:-translate-y-0.5 hover:border-black/30 hover:shadow-md';

  if (href) {
    return (
      <Link href={href} className={className}>
        {body}
      </Link>
    );
  }
  return <div className={className}>{body}</div>;
}
