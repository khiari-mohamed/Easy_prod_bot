/** Library key: lowercase, accents and Arabic diacritics removed, letters/digits/underscore only. */
export function normalizeTag(raw: string): string {
  return (raw ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}_]/gu, '')
    .toLowerCase();
}

/** What people see: original casing and accents, no '#', no spaces or punctuation. */
export function displayTag(raw: string): string {
  return (raw ?? '').normalize('NFC').replace(/^#+/, '').replace(/[^\p{L}\p{N}_\p{M}]/gu, '');
}

export function isValidTag(normalized: string): boolean {
  return normalized.length >= 2 && normalized.length <= 60 && !/^\d+$/.test(normalized);
}

/** Splits "#a #b, c" into raw tokens. */
export function splitTags(input: string): string[] {
  return input.split(/[\s,;]+/).filter(Boolean);
}