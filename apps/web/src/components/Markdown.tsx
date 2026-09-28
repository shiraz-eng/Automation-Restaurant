import { Fragment, type ReactNode } from 'react';

/**
 * A small, safe Markdown renderer for assistant replies: headings, bullet
 * and numbered lists, tables, code blocks, **bold**, *italic* and `code`.
 * Builds React elements only (never raw HTML), so model output can't
 * inject markup. Unknown syntax simply shows as text.
 */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim().startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) code.push(lines[i++]!);
      i++; // closing fence (or end of a still-streaming block)
      blocks.push(
        <pre key={key++} className="rounded bg-surface border border-border p-2 text-xs overflow-x-auto">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const size = heading[1]!.length <= 2 ? 'text-base' : 'text-sm';
      blocks.push(
        <p key={key++} className={`${size} font-bold mt-1`}>
          {inline(heading[2]!)}
        </p>,
      );
      i++;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        const cells = lines[i]!.trim().slice(1, -1).split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div key={key++} className="overflow-x-auto">
          <table className="text-xs border-collapse my-1">
            {head && (
              <thead>
                <tr>
                  {head.map((c, j) => (
                    <th key={j} className="border border-border px-2 py-1 text-left font-semibold">
                      {inline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j} className="border border-border px-2 py-1 tabular-nums">
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const bullet = /^(\s*)[-*•]\s+(.*)$/;
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line) && !bullet.test(line);
      const items: { depth: number; text: string }[] = [];
      while (i < lines.length && (bullet.test(lines[i]!) || numbered.test(lines[i]!))) {
        const m = bullet.exec(lines[i]!) ?? numbered.exec(lines[i]!)!;
        items.push({ depth: Math.min(Math.floor(m[1]!.length / 2), 3), text: m[2]! });
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={key++} className={`${ordered ? 'list-decimal' : 'list-disc'} pl-5 space-y-0.5`}>
          {items.map((it, j) => (
            <li key={j} style={it.depth ? { marginLeft: `${it.depth}rem` } : undefined}>
              {inline(it.text)}
            </li>
          ))}
        </List>,
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,4})\s/.test(lines[i]!) &&
      !/^\s*[-*•]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!) &&
      !/^\s*\|.*\|\s*$/.test(lines[i]!) &&
      !lines[i]!.trim().startsWith('```')
    ) {
      para.push(lines[i++]!);
    }
    blocks.push(
      <p key={key++}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="space-y-2 break-words">{blocks}</div>;
}

/** **bold**, *italic* / _italic_ and `code` inside one line. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k++} className="rounded bg-surface px-1 text-[0.9em]">{t.slice(1, -1)}</code>);
    else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
