/**
 * Turns Markdown text (an AI Assistant answer or a document it wrote) into a
 * PDF the viewer downloads. Headings, paragraphs, bullet/numbered lists,
 * tables and code blocks are laid out with jsPDF.
 *
 * jsPDF's built-in fonts only cover Latin characters, so text in Urdu,
 * Arabic, Hindi, Chinese… opens as a clean printable page instead, where the
 * browser's own "Save as PDF" renders every script correctly.
 */
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; head: string[]; body: string[][] }
  | { kind: 'code'; text: string };

function parse(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const isTable = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isBullet = (l: string) => /^\s*[-*•]\s+/.test(l);
  const isNumbered = (l: string) => /^\s*\d+[.)]\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim().startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) code.push(lines[i++]!);
      i++;
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: 'heading', level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (isTable(line)) {
      const rows: string[][] = [];
      while (i < lines.length && isTable(lines[i]!)) {
        const cells = lines[i]!.trim().slice(1, -1).split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      if (rows.length) blocks.push({ kind: 'table', head: rows[0]!, body: rows.slice(1) });
      continue;
    }
    if (isBullet(line) || isNumbered(line)) {
      const ordered = isNumbered(line) && !isBullet(line);
      const items: string[] = [];
      while (i < lines.length && (isBullet(lines[i]!) || isNumbered(lines[i]!))) {
        items.push(lines[i]!.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^#{1,4}\s/.test(lines[i]!) && !isBullet(lines[i]!) && !isNumbered(lines[i]!) && !isTable(lines[i]!) && !lines[i]!.trim().startsWith('```')) {
      para.push(lines[i++]!.trim());
    }
    blocks.push({ kind: 'para', text: para.join(' ') });
  }
  return blocks;
}

/** Inline Markdown markers removed for the jsPDF path (**bold**, *italic*, `code`). */
const plain = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2');

/** True when the text uses characters jsPDF's standard fonts can't draw. */
function needsBrowserFonts(text: string): boolean {
  // Latin, Latin-1, Latin Extended, general punctuation, currency, arrows, symbols and emoji-free.
  return /[^\u0000-ɏ -⁯₠-⃏℀-⅏←-⇿−•…★✓✔]/.test(text);
}

function fileName(title: string): string {
  return `${title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'document'}.pdf`;
}

export function downloadTextPdf(title: string, markdown: string): void {
  if (needsBrowserFonts(title + markdown)) {
    printablePage(title, markdown);
    return;
  }
  buildTextPdf(title, markdown).save(fileName(title));
}

/** The jsPDF document for Latin-script text (see downloadTextPdf). */
export function buildTextPdf(title: string, markdown: string): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 48;
  const width = W - M * 2;
  let y = M;
  const ensure = (h: number) => {
    if (y + h > H - M) {
      doc.addPage();
      y = M;
    }
  };
  const write = (text: string, size: number, style: 'normal' | 'bold', indent = 0, gap = 6) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(plain(text), width - indent) as string[];
    const lh = size * 1.35;
    for (const l of lines) {
      ensure(lh);
      doc.text(l, M + indent, y + size);
      y += lh;
    }
    y += gap;
  };

  doc.setTextColor(24, 24, 27);
  write(title, 18, 'bold', 0, 4);
  doc.setDrawColor(210, 210, 215);
  doc.line(M, y, W - M, y);
  y += 14;

  for (const b of parse(markdown)) {
    if (b.kind === 'heading') {
      y += 4;
      write(b.text, b.level <= 1 ? 15 : b.level === 2 ? 13 : 11.5, 'bold', 0, 4);
    } else if (b.kind === 'para') {
      write(b.text, 10.5, 'normal');
    } else if (b.kind === 'list') {
      b.items.forEach((it, n) => {
        const marker = b.ordered ? `${n + 1}.` : '•';
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10.5);
        ensure(14);
        doc.text(marker, M + 4, y + 10.5);
        write(it, 10.5, 'normal', 18, 2);
      });
      y += 4;
    } else if (b.kind === 'code') {
      doc.setFont('courier', 'normal');
      doc.setFontSize(9);
      for (const l of doc.splitTextToSize(b.text, width) as string[]) {
        ensure(12);
        doc.text(l, M, y + 9);
        y += 12;
      }
      y += 6;
    } else {
      autoTable(doc, {
        startY: y,
        head: [b.head.map(plain)],
        body: b.body.map((r) => r.map(plain)),
        margin: { left: M, right: M },
        styles: { fontSize: 9, cellPadding: 4 },
        headStyles: { fillColor: [24, 24, 27], textColor: 255 },
        theme: 'grid',
      });
      y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 12;
    }
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 150);
    doc.text(`${title} · page ${p} of ${pages}`, M, H - 24);
  }
  return doc;
}

/** Escaped HTML version of the Markdown, opened for the browser's "Save as PDF". */
function printablePage(title: string, markdown: string): void {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s: string) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const html = parse(markdown)
    .map((b) => {
      if (b.kind === 'heading') return `<h${Math.min(b.level + 1, 4)}>${inline(b.text)}</h${Math.min(b.level + 1, 4)}>`;
      if (b.kind === 'para') return `<p>${inline(b.text)}</p>`;
      if (b.kind === 'code') return `<pre>${esc(b.text)}</pre>`;
      if (b.kind === 'list') {
        const tag = b.ordered ? 'ol' : 'ul';
        return `<${tag}>${b.items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`;
      }
      return `<table><thead><tr>${b.head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${b.body
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`;
    })
    .join('\n');
  const w = window.open('', '_blank');
  if (!w) {
    alert('Allow pop-ups for this site to save the PDF.');
    return;
  }
  w.document.write(`<!doctype html><html dir="auto"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: "Noto Naskh Arabic", "Noto Nastaliq Urdu", "Segoe UI", Arial, sans-serif; color: #18181b; margin: 40px; line-height: 1.6; }
  h1 { font-size: 22px; border-bottom: 1px solid #d4d4d8; padding-bottom: 6px; }
  h2 { font-size: 18px; } h3, h4 { font-size: 15px; }
  table { border-collapse: collapse; margin: 8px 0; } th, td { border: 1px solid #d4d4d8; padding: 4px 8px; text-align: start; }
  th { background: #18181b; color: #fff; }
  pre { background: #f4f4f5; padding: 8px; white-space: pre-wrap; }
  @media print { body { margin: 0; } }
</style></head><body dir="auto"><h1>${esc(title)}</h1>${html}
<script>window.onload = function () { window.print(); };</script></body></html>`);
  w.document.close();
}
