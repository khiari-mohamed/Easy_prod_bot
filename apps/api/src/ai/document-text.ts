import JSZip from 'jszip';

export const PDF_MIME = 'application/pdf';
export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type PlanDocMime = typeof PDF_MIME | typeof PPTX_MIME | typeof DOCX_MIME;

/** Gemini inline requests are capped (~20 MB total); stay safely under it. */
export const MAX_DOC_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;

export function mimeFromFilename(filename: string): PlanDocMime | null {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'pdf') return PDF_MIME;
  if (ext === 'pptx') return PPTX_MIME;
  if (ext === 'docx') return DOCX_MIME;
  return null;
}

/** Checks the real file content, not the browser-reported MIME type. */
export function contentMatchesMime(buf: Buffer, mime: PlanDocMime): boolean {
  if (mime === PDF_MIME) return buf.subarray(0, 1024).includes('%PDF-');
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; // "PK" zip container
}

function codePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function paragraphs(xml: string, closeTag: string, textTag: string): string[] {
  const textRe = new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>`, 'g');
  return xml
    .split(closeTag)
    .map((chunk) => {
      let line = '';
      for (const m of chunk.matchAll(textRe)) line += decodeXml(m[1]);
      return line.trim();
    })
    .filter(Boolean);
}

/**
 * Plain text of a .pptx (slide by slide) or .docx. Gemini cannot read these formats as documents,
 * so the text is extracted here and sent as text. Image-only slides contain no text: export those
 * decks to PDF instead.
 */
export async function extractOfficeText(buf: Buffer, kind: 'pptx' | 'docx'): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error('Le fichier est corrompu ou n’est pas un document Office valide.');
  }

  let out = '';
  if (kind === 'pptx') {
    const slides = Object.keys(zip.files)
      .map((name) => ({ name, n: /^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1] }))
      .filter((s): s is { name: string; n: string } => !!s.n)
      .sort((a, b) => Number(a.n) - Number(b.n));
    for (const s of slides) {
      const xml = await zip.file(s.name)!.async('string');
      const lines = paragraphs(xml, '</a:p>', 'a:t');
      if (lines.length) out += `--- Slide ${Number(s.n)} ---\n${lines.join('\n')}\n\n`;
    }
  } else {
    const file = zip.file('word/document.xml');
    if (file) out = paragraphs(await file.async('string'), '</w:p>', 'w:t').join('\n');
  }

  out = out.trim().slice(0, MAX_TEXT_CHARS);
  if (out.replace(/\s/g, '').length < 20) {
    throw new Error(
      kind === 'pptx'
        ? 'Aucun texte lisible dans ce PPTX (diapositives en images ?). Exportez-le en PDF puis importez le PDF.'
        : 'Aucun texte lisible dans ce document Word.',
    );
  }
  return out;
}

export function extractHashtagsFromText(text: string): string[] {
  return [...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]);
}