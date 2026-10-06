/**
 * Minimal PDF writer (no dependencies) for statements: A4 pages, the standard Helvetica/Courier
 * fonts, text, lines and filled rectangles. Amount columns use Courier (fixed width) so they
 * right-align exactly without font metric tables.
 */
type Font = 'regular' | 'bold' | 'mono' | 'monoBold';
const FONT_REF: Record<Font, string> = { regular: 'F1', bold: 'F2', mono: 'F3', monoBold: 'F4' };
const BASE_FONT: Record<Font, string> = { regular: 'Helvetica', bold: 'Helvetica-Bold', mono: 'Courier', monoBold: 'Courier-Bold' };

export const PAGE = { width: 595, height: 842, margin: 42 };

/** PDF standard fonts use WinAnsi (Latin-1); map common typographic characters and drop the rest. */
function latin1(s: string) {
  return String(s ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/×/g, 'x')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}
const esc = (s: string) => latin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export class PdfDoc {
  private pages: string[][] = [];
  private cur: string[] = [];
  /** Cursor: distance from the top of the page. */
  y = PAGE.margin;

  constructor() { this.addPage(); }

  addPage() { this.cur = []; this.pages.push(this.cur); this.y = PAGE.margin; }
  /** Start a new page if `needed` points do not fit. Returns true when a page was added. */
  ensure(needed: number) { if (this.y + needed > PAGE.height - PAGE.margin) { this.addPage(); return true; } return false; }

  private py(y: number) { return (PAGE.height - y).toFixed(2); }
  color(r: number, g: number, b: number) { this.cur.push(`${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)} rg`); return this; }

  text(x: number, y: number, s: string, font: Font = 'regular', size = 10) {
    this.cur.push(`BT /${FONT_REF[font]} ${size} Tf ${x.toFixed(2)} ${this.py(y)} Td (${esc(s)}) Tj ET`);
    return this;
  }
  /** Right-aligned text in a fixed-width font: x is the right edge. */
  right(x: number, y: number, s: string, size = 9, bold = false) {
    const str = latin1(s);
    return this.text(x - str.length * size * 0.6, y, str, bold ? 'monoBold' : 'mono', size);
  }
  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, grey = 0.75) {
    this.cur.push(`${grey} G ${width} w ${x1.toFixed(2)} ${this.py(y1)} m ${x2.toFixed(2)} ${this.py(y2)} l S`);
    return this;
  }
  rect(x: number, y: number, w: number, h: number, rgb: [number, number, number]) {
    this.cur.push(`${rgb.map((c) => (c / 255).toFixed(3)).join(' ')} rg ${x.toFixed(2)} ${(PAGE.height - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 0 0 rg`);
    return this;
  }

  build(): Buffer {
    const objs: string[] = [];
    const add = (body: string) => { objs.push(body); return objs.length; };
    const fonts = (Object.keys(FONT_REF) as Font[]).map((f) => [FONT_REF[f], add(`<< /Type /Font /Subtype /Type1 /BaseFont /${BASE_FONT[f]} /Encoding /WinAnsiEncoding >>`)] as const);
    const fontDict = fonts.map(([ref, id]) => `/${ref} ${id} 0 R`).join(' ');
    const pagesId = objs.length + 1 + this.pages.length * 2; // reserved: page tree comes after all pages
    const pageIds: number[] = [];
    this.pages.forEach((ops, i) => {
      const footer = `BT /F1 8 Tf 0.45 0.45 0.45 rg ${PAGE.margin} 24 Td (Page ${i + 1} of ${this.pages.length}) Tj ET`;
      const stream = ops.concat(footer).join('\n');
      const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << ${fontDict} >> >> /Contents ${contentId} 0 R >>`));
    });
    add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
