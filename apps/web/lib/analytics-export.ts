import { PLATFORM_LABEL } from '@/lib/format';
import {
  METRICS, fmtLocal, plainNum, plainPct,
  type Overview, type PostRow, type SeriesPoint, type Stats,
} from '@/lib/analytics';

export interface ExportCtx {
  periodLabel: string;
  platformsLabel: string;
  overview: Overview;
  series: SeriesPoint[];
  posts: PostRow[];
  /** Element containing the charts (cards with data-export). Used by the PDF only. */
  root: HTMLElement | null;
}

const stamp = () => fmtLocal(new Date().toISOString());
const fileBase = (ctx: ExportCtx) => `analytics_whatelse_${ctx.periodLabel.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '')}`;
const platformName = (p: string) => (p === 'ALL' ? 'Total' : PLATFORM_LABEL[p as keyof typeof PLATFORM_LABEL] ?? p);

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Blank cell = unavailable (never 0). */
const blank = (n: number | null) => (n === null ? '' : String(n));

// ---------------------------------------------------------------- CSV

function csvCell(v: string): string {
  // Neutralise spreadsheet formulas coming from captions.
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return /[";\\n\\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** `;` separator + BOM so Excel (French locale) opens it correctly, Arabic included. */
export function exportCsv(ctx: ExportCtx) {
  const head = ['Plateforme', 'Date (Tunis)', 'Format', 'Vues', 'Portée', 'J\u2019aime', 'Commentaires', 'Partages', 'Enregistrements', 'Interactions', 'Engagement (%)', 'Import externe', 'URL', 'Légende'];
  const lines = ctx.posts.map((p) =>
    [
      platformName(p.platform), fmtLocal(p.publishedAt), p.format,
      blank(p.views), blank(p.reach), blank(p.likes), blank(p.comments), blank(p.shares), blank(p.saves), blank(p.interactions),
      p.engagementRate === null ? '' : (p.engagementRate * 100).toFixed(2).replace('.', ','),
      p.isExternal ? 'oui' : 'non', p.externalUrl ?? '', p.caption,
    ].map(csvCell).join(';'),
  );
  const csv = '\uFEFF' + [head.map(csvCell).join(';'), ...lines].join('\r\n');
  download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${fileBase(ctx)}.csv`);
}

// ---------------------------------------------------------------- XLSX

function statsRow(s: Stats) {
  return {
    Plateforme: platformName(s.platform),
    Posts: s.posts,
    Vues: s.views ?? undefined,
    Portée: s.reach ?? undefined,
    'J\u2019aime': s.likes ?? undefined,
    Commentaires: s.comments ?? undefined,
    Partages: s.shares ?? undefined,
    Enregistrements: s.saves ?? undefined,
    Interactions: s.interactions ?? undefined,
    Engagement: s.engagementRate ?? undefined,
  };
}

export async function exportXlsx(ctx: ExportCtx) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const t = ctx.overview.totals;
  const pv = ctx.overview.previousTotals;

  const summary = XLSX.utils.aoa_to_sheet([
    ['What Else - Rapport analytics'],
    ['Période', ctx.periodLabel],
    ['Plateformes', ctx.platformsLabel],
    ['Généré le', stamp()],
    [],
    ['Indicateur', 'Période', 'Période précédente'],
    ['Posts', t.posts, pv?.posts ?? ''],
    ['Vues', t.views ?? '', pv?.views ?? ''],
    ['Portée', t.reach ?? '', pv?.reach ?? ''],
    ['Interactions', t.interactions ?? '', pv?.interactions ?? ''],
    ['Engagement', t.engagementRate ?? '', pv?.engagementRate ?? ''],
    [],
    ['Cellule vide = indisponible (la plateforme ne fournit pas ce chiffre), ce n\u2019est pas un zéro.'],
  ]);
  summary['!cols'] = [{ wch: 18 }, { wch: 30 }, { wch: 20 }];
  for (const r of [11]) {
    for (const c of ['B', 'C']) {
      const cell = summary[`${c}${r}`];
      if (cell && typeof cell.v === 'number') cell.z = '0.0%';
    }
  }
  XLSX.utils.book_append_sheet(wb, summary, 'Résumé');

  const platforms = XLSX.utils.json_to_sheet(ctx.overview.platforms.map(statsRow));
  platforms['!cols'] = Array(10).fill({ wch: 14 });
  XLSX.utils.book_append_sheet(wb, platforms, 'Plateformes');

  const days = XLSX.utils.json_to_sheet(
    ctx.series.map((s) => ({ Date: s.date, ...statsRow(s) })),
  );
  days['!cols'] = Array(11).fill({ wch: 14 });
  XLSX.utils.book_append_sheet(wb, days, 'Par jour');

  const posts = XLSX.utils.json_to_sheet(
    ctx.posts.map((p) => ({
      Plateforme: platformName(p.platform),
      'Date (Tunis)': fmtLocal(p.publishedAt),
      Format: p.format,
      Vues: p.views ?? undefined,
      Portée: p.reach ?? undefined,
      'J\u2019aime': p.likes ?? undefined,
      Commentaires: p.comments ?? undefined,
      Partages: p.shares ?? undefined,
      Enregistrements: p.saves ?? undefined,
      Interactions: p.interactions ?? undefined,
      Engagement: p.engagementRate ?? undefined,
      'Import externe': p.isExternal ? 'oui' : 'non',
      URL: p.externalUrl ?? undefined,
      Légende: p.caption,
    })),
  );
  posts['!cols'] = [{ wch: 11 }, { wch: 17 }, { wch: 9 }, ...Array(8).fill({ wch: 13 }), { wch: 11 }, { wch: 40 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, posts, 'Posts');

  // Percent format on engagement columns.
  for (const [ws, col] of [[platforms, 'J'], [days, 'K'], [posts, 'K']] as const) {
    const ref = ws['!ref'];
    if (!ref) continue;
    const last = XLSX.utils.decode_range(ref).e.r + 1;
    for (let r = 2; r <= last; r++) {
      const cell = ws[`${col}${r}`];
      if (cell && typeof cell.v === 'number') cell.z = '0.0%';
    }
  }

  XLSX.writeFile(wb, `${fileBase(ctx)}.xlsx`);
}

// ---------------------------------------------------------------- PDF

async function svgToPng(svg: SVGSVGElement): Promise<{ data: string; w: number; h: number } | null> {
  const r = svg.getBoundingClientRect();
  const w = Math.ceil(r.width);
  const h = Math.ceil(r.height);
  if (!w || !h) return null;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  clone.setAttribute('font-family', 'Helvetica, Arial, sans-serif');
  const xml = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  await new Promise<void>((ok, ko) => {
    img.onload = () => ok();
    img.onerror = () => ko(new Error('svg'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = w * 2;
  canvas.height = h * 2;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.scale(2, 2);
  g.drawImage(img, 0, 0, w, h);
  return { data: canvas.toDataURL('image/png'), w, h };
}

/** Standard PDF fonts have no Arabic/emoji glyphs: keep Latin text only. */
const latin = (s: string, max = 70) => {
  const t = s.replace(/[^\u0020-\u00FF]/g, '').replace(/\s+/g, ' ').trim();
  return (t || '(légende non latine)').slice(0, max);
};

const hex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
];

export async function exportPdf(ctx: ExportCtx) {
  const [{ jsPDF }, atMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = atMod.default;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 14;
  const lastY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  const headStyles = { fillColor: [17, 24, 39] as [number, number, number], textColor: 255, fontSize: 9 };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(17, 24, 39);
  doc.text('What Else - Rapport analytics', M, 18);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Période : ${ctx.periodLabel}`, M, 25);
  doc.text(`Plateformes : ${ctx.platformsLabel}   |   Généré le ${stamp()}`, M, 30);

  const t = ctx.overview.totals;
  autoTable(doc, {
    startY: 35,
    head: [['Posts', 'Vues', 'Portée', 'Interactions', 'Engagement']],
    body: [[plainNum(t.posts), plainNum(t.views), plainNum(t.reach), plainNum(t.interactions), plainPct(t.engagementRate)]],
    headStyles,
    styles: { fontSize: 14, halign: 'center', cellPadding: 3 },
    margin: { left: M, right: M },
  });

  autoTable(doc, {
    startY: lastY() + 6,
    head: [['Plateforme', 'Posts', ...METRICS.map((m) => m.label), 'Interactions', 'Engagement']],
    body: ctx.overview.platforms.map((s) => [
      platformName(s.platform), plainNum(s.posts),
      ...METRICS.map((m) => plainNum(s[m.key])), plainNum(s.interactions), plainPct(s.engagementRate),
    ]),
    headStyles,
    styles: { fontSize: 9 },
    margin: { left: M, right: M },
    foot: [['"- " = indisponible (pas un zéro).']],
    footStyles: { fillColor: [255, 255, 255], textColor: 120, fontSize: 8, fontStyle: 'normal' },
  });

  // ---- charts
  const cards = ctx.root ? [...ctx.root.querySelectorAll<HTMLElement>('[data-export]')] : [];
  if (cards.length) {
    doc.addPage();
    let y = M;
    let col = 0;
    let rowH = 0;
    const gap = 6;
    const colW = (W - 2 * M - 8) / 2;
    for (const card of cards) {
      const svg = card.querySelector<SVGSVGElement>('svg.recharts-surface');
      if (!svg) continue;
      let img: Awaited<ReturnType<typeof svgToPng>> = null;
      try { img = await svgToPng(svg); } catch { img = null; }
      if (!img) continue;
      const wide = card.dataset.wide === '1';
      const w = wide ? W - 2 * M : colW;
      const h = (w * img.h) / img.w + 14;
      if (wide && col === 1) { y += rowH + gap; col = 0; rowH = 0; }
      if (col === 0 && y + h > H - 12) { doc.addPage(); y = M; }
      const x = wide ? M : M + col * (colW + 8);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(17, 24, 39);
      doc.text(card.dataset.export ?? '', x, y + 4);
      let lx = x;
      const legend: [string, string][] = card.dataset.legend ? JSON.parse(card.dataset.legend) : [];
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      for (const [label, color] of legend) {
        doc.setFillColor(...hex(color));
        doc.rect(lx, y + 6.2, 2.5, 2.5, 'F');
        doc.setTextColor(90);
        doc.text(label, lx + 3.6, y + 8.4);
        lx += 3.6 + doc.getTextWidth(label) + 4;
      }
      doc.addImage(img.data, 'PNG', x, y + 11, w, h - 14);

      if (wide) { y += h + gap; } else {
        rowH = Math.max(rowH, h);
        col++;
        if (col === 2) { y += rowH + gap; col = 0; rowH = 0; }
      }
    }
    if (col === 1) y += rowH + gap;
    (doc as unknown as { __y?: number }).__y = y;
  }

  // ---- top posts + post list
  doc.addPage();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(17, 24, 39);
  doc.text('Meilleurs posts', M, 16);
  autoTable(doc, {
    startY: 20,
    head: [['Plateforme', 'Date', 'Légende', 'Vues', 'Portée', 'Interactions', 'Engagement']],
    body: ctx.overview.topPosts.map((p) => [
      platformName(p.platform), fmtLocal(p.publishedAt), latin(p.caption),
      plainNum(p.views), plainNum(p.reach), plainNum(p.interactions), plainPct(p.engagementRate),
    ]),
    headStyles,
    styles: { fontSize: 8 },
    margin: { left: M, right: M },
  });

  const LIMIT = 100;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(`Posts publiés (${Math.min(ctx.posts.length, LIMIT)} sur ${ctx.posts.length})`, M, lastY() + 12);
  autoTable(doc, {
    startY: lastY() + 15,
    head: [['Date', 'Plateforme', 'Légende', 'Vues', 'Portée', 'Interactions', 'Engagement']],
    body: ctx.posts.slice(0, LIMIT).map((p) => [
      fmtLocal(p.publishedAt), platformName(p.platform), latin(p.caption, 60),
      plainNum(p.views), plainNum(p.reach), plainNum(p.interactions), plainPct(p.engagementRate),
    ]),
    headStyles,
    styles: { fontSize: 8 },
    margin: { left: M, right: M },
  });
  if (ctx.posts.length > LIMIT) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text('Liste complète (avec légendes en arabe) : exports Excel ou CSV.', M, lastY() + 6);
  }

  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`What Else - Easy Distribution   |   Page ${i}/${n}`, W - M, H - 6, { align: 'right' });
  }
  doc.save(`${fileBase(ctx)}.pdf`);
}
