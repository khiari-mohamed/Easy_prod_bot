import { CaptionLanguage } from '@prisma/client';
import { PLACEHOLDER_RE } from '../posts/post.rules';

const normAr = (s: string) => s.replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/ى/g, 'ي');
const arSet = (w: string[]) => new Set(w.map(normAr));

const ENGLISH = new Set([
  'the', 'and', 'with', 'your', 'you', 'this', 'that', 'now', 'watch', 'only', 'get', 'tickets', 'book', 'coming',
  'soon', 'will', 'are', 'our', 'from', 'join', 'we', 'just', 'see', 'out', 'new', 'love', 'best', 'only', 'cinemas',
]);

const FRENCH = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'est', 'au', 'aux', 'dans', 'pour', 'sur', 'avec', 'nous',
  'vous', 'votre', 'vos', 'notre', 'ce', 'cette', 'ces', 'bientôt', 'bientot', 'découvrez', 'decouvrez', 'cinéma',
  'cinema', 'salles', 'film', 'sortie', 'octobre', 'dès', 'des', 'enfin', 'plus', 'que', 'qui', 'pas', 'tous', 'ne',
]);

/** Tunisian Latin transliteration ("arabizi") markers. */
const DARIJA_LATIN = new Set([
  'barcha', 'behi', 'bahi', 'mouch', 'mech', 'chnowa', 'chnoua', 'nchallah', 'inchallah', 'yesser', 'yaser', 'bech',
  'besh', 'ena', 'enti', 'houwa', 'hiya', 'tawa', 'taw', 'kifech', 'aaslema', 'aslema', '3aslema', 'ya3tik',
  'ya3tikom', '9ouli', 'brabi', 'mte3', 'mta3', 'famma', 'fama', '3andek', '3andkom', 'nestanew', 'testanew',
]);

/** Tunisian Arabic-script markers. */
const DARIJA_AR = arSet([
  'برشا', 'باش', 'شنوة', 'شنية', 'توا', 'هاذي', 'هاذا', 'هاذاكا', 'يعيشك', 'ياسر', 'موش', 'فما', 'كيفاش', 'علاش',
  'عالسلامة', 'يزّي', 'بهي', 'ملّا', 'ملا', 'متاع', 'مالا', 'نستناو', 'تستناو', 'تستنّاكم', 'تستناكم', 'يلزمك', 'لازمك',
  'عندكم', 'نحبو', 'تو',
]);

/** Modern Standard Arabic (fusha) forms that must not replace Darija. */
const MSA = arSet([
  'هذا', 'هذه', 'ماذا', 'لماذا', 'الذي', 'التي', 'الذين', 'سوف', 'يمكنكم', 'أيضا', 'أيضاً', 'حيث', 'لقد', 'جميع',
  'ندعوكم', 'يسعدنا', 'قريبا', 'قريباً', 'شاهدوا', 'اكتشفوا', 'انتظروا', 'ترقبوا', 'ستشاهدون', 'بكل', 'نحن',
]);

const latinTokens = (t: string) => t.toLowerCase().match(/[a-zà-ÿœ0-9]+/g) ?? [];
const arabicTokens = (t: string) => (t.match(/[\u0600-\u06FF]+/g) ?? []).map(normAr);
const hits = (tokens: string[], set: Set<string>) => new Set(tokens.filter((x) => set.has(x))).size;
const count = (t: string, re: RegExp) => (t.match(re) ?? []).length;

/** Best-effort lint. It produces warnings for the reviewer: the human approval is the real gate. */
export function lintCaption(text: string, language: CaptionLanguage): string[] {
  const w: string[] = [];
  const lat = latinTokens(text);
  const ar = arabicTokens(text);
  const arChars = count(text, /[\u0600-\u06FF]/g);
  const latChars = count(text, /[A-Za-zÀ-ÿ]/g);
  const arRatio = arChars / Math.max(arChars + latChars, 1);

  const english = hits(lat, ENGLISH);
  const msa = hits(ar, MSA);
  const french = hits(lat, FRENCH);
  const darijaLatin = hits(lat, DARIJA_LATIN);
  const darijaAr = hits(ar, DARIJA_AR);
  const hasDarija = darijaAr >= 1 || darijaLatin >= 2 || (arChars >= 6 && msa === 0);

  if (english >= 2) w.push('Contient peut-être de l’anglais : seuls le darija tunisien et le français sont autorisés.');
  if (msa >= 2) w.push('Arabe littéraire (fusha) détecté : utilisez le darija tunisien.');

  if (language === 'FRENCH') {
    if (arRatio > 0.1) w.push('Langue FRANÇAIS choisie mais le texte contient de l’arabe.');
    if (latChars >= 40 && french < 2) w.push('Ce texte ne ressemble pas à du français naturel.');
  } else if (language === 'DARIJA') {
    if (!hasDarija) w.push('Langue DARIJA choisie mais aucun signe de darija tunisien n’a été détecté.');
    else if (french >= 6 && arChars < 6 && darijaLatin < 2) w.push('Ce texte ressemble à du français : le darija est attendu.');
  } else {
    if (!hasDarija) w.push('Langue MIXTE choisie mais aucune touche de darija n’a été détectée.');
    if (french < 1 && darijaLatin < 2 && latChars < 8) w.push('Langue MIXTE choisie mais aucun mot de français n’a été détecté.');
  }

  if (text.includes('#')) w.push('Les hashtags doivent être séparés de la légende : retirez-les du texte.');
  if (PLACEHOLDER_RE.test(text)) w.push('Contient un [PLACEHOLDER] à compléter avant publication (lieu, heure, lien…).');
  return w;
}

// ---------------------------------------------------------------------------------------------
// Fact preservation: anything factual in the caption must be traceable to the brief / plan / media.

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const HANDLE_RE = /(?<![\w.])@[A-Za-z0-9_.]{2,30}/g;
const TIME_RE = /\b(?:[01]?\d|2[0-3])\s*(?:h|:)\s*(?:[0-5]\d)?(?![\p{L}\d])/giu;
const DATE_WORD_RE =
  /\b\d{1,2}\s*(?:janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)(?:\s+\d{4})?/gi;
const DATE_NUM_RE = /\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/g;

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');

export function checkFacts(text: string, allowedContext: string): string[] {
  const allowed = squash(allowedContext);
  const out: string[] = [];
  const probe = (re: RegExp, label: string, clean?: (s: string) => string) => {
    for (const m of text.match(re) ?? []) {
      const value = clean ? clean(m) : m;
      if (!allowed.includes(squash(value))) out.push(`${label} absent(e) du brief : « ${value.trim()} » — vérifiez avant d’approuver.`);
    }
  };
  probe(URL_RE, 'Lien', (s) => s.replace(/[.,;:!?)\]]+$/, ''));
  probe(HANDLE_RE, 'Compte');
  probe(DATE_WORD_RE, 'Date');
  probe(DATE_NUM_RE, 'Date');
  probe(TIME_RE, 'Heure');
  return [...new Set(out)];
}

/** Claims of virality are only allowed when verified trend data was provided to the model. */
const TREND_CLAIM_RE = /\b(trending|tendance|viral|buzz)\b|تريند/i;
export function checkTrendClaims(text: string, hasVerifiedTrends: boolean): string[] {
  return !hasVerifiedTrends && TREND_CLAIM_RE.test(text)
    ? ['Mentionne une tendance alors qu’aucune donnée de tendance vérifiée n’a été fournie.']
    : [];
}