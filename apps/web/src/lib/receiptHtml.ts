import type { ReceiptBlock, DividerStyle } from './receiptTemplate';

/**
 * Walks the SAME ReceiptBlock list generateReceipt.ts's PDF builder and
 * the live preview walk, and turns it into the print window's HTML body —
 * the one place browser-print formatting lives, replacing CheckoutClient's
 * previous hand-rolled per-field HTML.
 */
const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);

function dividerHtml(style: DividerStyle): string {
  if (style === 'space') return '<div class="sp"></div>';
  if (style === 'double') return '<hr class="dbl"/>';
  if (style === 'solid') return '<hr class="solid"/>';
  return '<hr/>'; // dashed (default)
}

export function renderReceiptBlocksHtml(blocks: ReceiptBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'logo':
          return `<img src="${esc(b.url)}" alt="" class="logo logo-${b.size}" style="display:block;margin:${b.align === 'center' ? '0 auto' : b.align === 'right' ? '0 0 0 auto' : '0'} 6px" />`;
        case 'text':
          return `<div class="t-${b.align}${b.bold ? ' bold' : ''}${b.size === 'lg' ? ' lg' : b.size === 'sm' ? ' sm' : ''}${b.muted ? ' muted' : ''}">${esc(b.text)}</div>`;
        case 'divider':
          return dividerHtml(b.style);
        case 'row':
          return `<div class="row${b.bold ? ' bold' : ''}"><span>${esc(b.label)}</span><span>${esc(b.value)}</span></div>`;
        case 'item': {
          const sub = (b.sub ?? []).map((s) => `<div class="sub">${esc(s)}</div>`).join('');
          return `<div class="row"><span>${b.qty}&times; ${esc(b.name)}</span><span>${esc(b.total)}</span></div>${sub}`;
        }
        case 'space':
          return '<div class="sp"></div>';
        default:
          return '';
      }
    })
    .join('\n');
}

export const RECEIPT_PRINT_STYLES = `
  body{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#111;padding:14px;margin:0 auto}
  .t-left{text-align:left}.t-center{text-align:center}.t-right{text-align:right}
  .bold{font-weight:bold}.lg{font-size:15px}.sm{font-size:10px}.muted{color:#666}
  .row{display:flex;justify-content:space-between;gap:8px;padding:1px 0}
  .sub{padding-left:12px;font-size:10.5px;color:#444}
  hr{border:none;border-top:1px dashed #999;margin:6px 0}
  hr.solid{border-top:1px solid #333}
  hr.dbl{border-top:3px double #333}
  .sp{height:8px}
  .logo{max-width:70%;object-fit:contain}
  .logo-sm{max-height:32px}.logo-md{max-height:52px}.logo-lg{max-height:76px}
`;
