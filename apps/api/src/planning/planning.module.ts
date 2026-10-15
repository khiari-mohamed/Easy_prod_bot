import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { CaptionLanguage, Platform, PostFormat, Prisma, PublishMode, Role } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsOptional, IsString } from 'class-validator';
import { memoryStorage } from 'multer';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { cleanTag, GeminiService, PlanRow } from '../ai/gemini.service';
import {
  contentMatchesMime,
  DOCX_MIME,
  MAX_DOC_BYTES,
  mimeFromFilename,
  PDF_MIME,
  PlanDocMime,
  PPTX_MIME,
} from '../ai/document-text';

const PLATFORMS = new Set<string>(['FACEBOOK', 'INSTAGRAM', 'TIKTOK']);
const FORMATS = new Set<string>(['IMAGE', 'VIDEO', 'REEL', 'STORY', 'TEXT']);
const LANGUAGES = new Set<string>(['DARIJA', 'FRENCH', 'DARIJA_FRENCH']);
const MODES = new Set<string>(['AUTO', 'MANUAL']);
const MAX_CSV_ROWS = 500;
const DEFAULT_TZ = 'Africa/Tunis';

type ImportKind = 'CSV' | 'PDF' | 'PPTX' | 'DOCX';
const MIME_TO_KIND: Record<PlanDocMime, ImportKind> = {
  [PDF_MIME]: 'PDF',
  [PPTX_MIME]: 'PPTX',
  [DOCX_MIME]: 'DOCX',
};

interface ParsedRow {
  rowIndex: number;
  date: Date | null;
  phase: string;
  label: string;
  content: string;
  execution: string;
  objective: string;
  platforms: Platform[];
  format: PostFormat;
  timeOfDay: string | null;
  caption: string | null;
  captionLanguage: CaptionLanguage | null;
  publishMode: PublishMode | null;
  assetRef: string | null;
  error: string | null;
  warning: string | null;
  dedupeKey: string | null;
}

// ------------------------------------------------------------------ dates (campaign timezone)

function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs;
}

/** The instant at which the given calendar day (YYYY-MM-DD) starts in `tz`. */
function zonedMidnight(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const off1 = tzOffsetMs(guess, tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

function isRealYmd(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const pad2 = (n: string | number) => String(n).padStart(2, '0');

/** YYYY-MM-DD, DD/MM/YYYY (Tunisian convention) or a full ISO date-time. Always returns local midnight. */
function parseDay(input: string, tz: string): Date | null {
  const s = input.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    return isRealYmd(+m[1], +m[2], +m[3]) ? zonedMidnight(`${m[1]}-${m[2]}-${m[3]}`, tz) : null;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    return isRealYmd(+m[3], +m[2], +m[1]) ? zonedMidnight(`${m[3]}-${pad2(m[2])}-${pad2(m[1])}`, tz) : null;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return zonedMidnight(ymd, tz);
}

// ------------------------------------------------------------------ CSV

/** RFC 4180-style parser: quoted fields, escaped quotes, commas/newlines inside quotes. */
function parseCsvRecords(text: string, delim: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      out.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    out.push(row);
  }
  return out.filter((r) => r.some((c) => c.trim()));
}

function parseCsv(buf: Buffer, tz: string): ParsedRow[] {
  if (buf.includes(0)) throw new BadRequestException('Ce fichier n’est pas un CSV texte.');
  const text = buf.toString('utf-8').replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = firstLine.includes(';') ? ';' : ',';
  const records = parseCsvRecords(text, delim);
  if (records.length < 2) throw new BadRequestException('Le CSV doit contenir une ligne d’en-tête et au moins une ligne de données.');
  if (records.length - 1 > MAX_CSV_ROWS) throw new BadRequestException(`Trop de lignes (max ${MAX_CSV_ROWS}).`);

  const headers = records[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return records.slice(1).map((cells, idx) => {
    const col = (name: string): string => {
      const i = headers.indexOf(name);
      return i >= 0 ? (cells[i] ?? '').trim() : '';
    };
    return parseRow(col, idx + 1, tz);
  });
}

function dedupe(date: Date | null, time: string | null, platforms: Platform[], label: string): string | null {
  if (!date || !platforms.length) return null;
  return createHash('sha256')
    .update(`${date.toISOString()}|${time ?? ''}|${[...platforms].sort().join(',')}|${label}`)
    .digest('hex')
    .slice(0, 16);
}

function parseRow(col: (n: string) => string, rowIndex: number, tz: string): ParsedRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  const dateStr = col('date');
  let date: Date | null = null;
  if (dateStr) {
    date = parseDay(dateStr, tz);
    if (!date) errors.push(`Date invalide : "${dateStr}"`);
  } else errors.push('Date manquante');

  const rawPlatforms = col('platforms')
    .split(/[|,]/)
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
  const platforms = [...new Set(rawPlatforms.filter((p) => PLATFORMS.has(p)))] as Platform[];
  if (!platforms.length) errors.push(`Aucune plateforme valide (reçu : "${col('platforms')}")`);

  const rawFormat = col('format').toUpperCase();
  const format: PostFormat = FORMATS.has(rawFormat) ? (rawFormat as PostFormat) : 'REEL';
  if (!FORMATS.has(rawFormat)) warnings.push(`Format "${rawFormat}" inconnu, REEL par défaut`);

  const rawLang = col('caption_language').toUpperCase();
  const rawMode = col('publish_mode').toUpperCase();
  const caption = col('caption') || null;
  const assetRef = col('asset_ref') || col('asset') || null;
  const timeOfDay = col('time_of_day') || col('time') || null;
  if (!caption) warnings.push('Pas de légende : à rédiger avant publication');
  if (!assetRef && format !== 'TEXT') warnings.push('Pas de média référencé : à joindre');

  const label = col('label') || col('title') || `Jour ${rowIndex}`;
  return {
    rowIndex,
    date,
    phase: col('phase') || 'PHASE',
    label,
    content: col('content') || col('contenu'),
    execution: col('execution') || col('exécution'),
    objective: col('objective') || col('objectif'),
    platforms,
    format,
    timeOfDay,
    caption,
    captionLanguage: LANGUAGES.has(rawLang) ? (rawLang as CaptionLanguage) : null,
    publishMode: MODES.has(rawMode) ? (rawMode as PublishMode) : null,
    assetRef,
    error: errors.length ? errors.join('; ') : null,
    warning: warnings.length ? warnings.join('; ') : null,
    dedupeKey: dedupe(date, timeOfDay, platforms, label),
  };
}

function aiRowToParsedRow(r: PlanRow, rowIndex: number, tz: string): ParsedRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  const date = r.date ? parseDay(r.date, tz) : null;
  if (!date) errors.push(`Date invalide : "${r.date ?? ''}"`);

  const platforms = [...new Set((r.platforms ?? []).map((p) => p.toUpperCase()).filter((p) => PLATFORMS.has(p)))] as Platform[];
  if (!platforms.length) errors.push('Aucune plateforme valide');

  const rawFormat = (r.format ?? '').toUpperCase();
  const format: PostFormat = FORMATS.has(rawFormat) ? (rawFormat as PostFormat) : 'REEL';
  if (!FORMATS.has(rawFormat)) warnings.push(`Format "${rawFormat}" inconnu, REEL par défaut`);
  if (!r.caption) warnings.push('Pas de légende : à rédiger avant publication');

  const label = r.label || `Jour ${rowIndex}`;
  return {
    rowIndex,
    date,
    phase: r.phase || 'PHASE',
    label,
    content: r.content || '',
    execution: r.execution || '',
    objective: r.objective || '',
    platforms,
    format,
    timeOfDay: r.timeOfDay ?? null,
    caption: r.caption ?? null,
    captionLanguage: null,
    publishMode: null,
    assetRef: null,
    error: errors.length ? errors.join('; ') : null,
    warning: warnings.length ? warnings.join('; ') : null,
    dedupeKey: dedupe(date, r.timeOfDay ?? null, platforms, label),
  };
}

/** Multer decodes names as latin1; restore UTF-8 names (Arabic, accents) unless already correct. */
function fixFilename(name: string): string {
  if ([...name].some((ch) => ch.charCodeAt(0) > 255)) return name;
  const fixed = Buffer.from(name, 'latin1').toString('utf8');
  return fixed.includes('\uFFFD') ? name : fixed;
}

function docMimeOf(name: string, reported: string): PlanDocMime | null {
  const byName = mimeFromFilename(name);
  if (byName) return byName;
  if (reported === PDF_MIME || reported === PPTX_MIME || reported === DOCX_MIME) return reported;
  return null;
}

const isCsvLike = (name: string, mime: string) => /\.(csv|txt)$/i.test(name) || mime === 'text/csv' || mime === 'text/plain';

class CommitDto {
  /** Hashtags detected in the document that the approver chose to add to the campaign's official hashtags. */
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) addHashtags?: string[];
}

const metaKey = (importId: string) => `planimport:${importId}`;

@Controller('planning')
export class PlanningController {
  private readonly log = new Logger(PlanningController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly gemini: GeminiService,
  ) {}

  @Get('imports')
  listImports() {
    return this.prisma.planImport.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { rows: true } } },
      take: 50,
    });
  }

  @Get('imports/:id')
  async getImport(@Param('id') id: string) {
    const imp = await this.prisma.planImport.findUnique({
      where: { id },
      include: { rows: { orderBy: { rowIndex: 'asc' } } },
    });
    if (!imp) throw new NotFoundException();
    const meta = await this.prisma.setting.findUnique({ where: { key: metaKey(id) } });
    return { ...imp, meta: meta?.value ?? null };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('imports/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_DOC_BYTES },
      fileFilter: (_req, file, cb) => {
        const name = fixFilename(file.originalname);
        const ok = !!docMimeOf(name, file.mimetype) || isCsvLike(name, file.mimetype);
        cb(ok ? null : new BadRequestException('Formats acceptés : CSV, PDF, PPTX ou Word (.docx)'), ok);
      },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthUser) {
    if (!file) throw new BadRequestException('Aucun fichier reçu (champ : file)');
    if (!file.buffer?.length) throw new BadRequestException('Fichier vide.');
    const filename = fixFilename(file.originalname);

    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    const existing = await this.prisma.planImport.findFirst({ where: { fileChecksum: checksum } });
    if (existing) {
      throw new BadRequestException(
        `Ce fichier a déjà été importé (import ${existing.id}, statut : ${existing.status}). Supprimez-le d’abord pour le réimporter.`,
      );
    }

    const campaign = await this.prisma.campaign.findFirst({ orderBy: { createdAt: 'desc' } });
    const tz = campaign?.timezone ?? DEFAULT_TZ;

    const docMime = docMimeOf(filename, file.mimetype);
    let rows: ParsedRow[];
    let source: ImportKind = 'CSV';
    let warnings: string[] = [];
    let documentHashtags: string[] = [];

    if (docMime) {
      if (!this.gemini.enabled) throw new BadRequestException('GEMINI_API_KEY est requise pour importer un PDF, PPTX ou Word.');
      if (!contentMatchesMime(file.buffer, docMime)) {
        throw new BadRequestException('Le contenu du fichier ne correspond pas à son extension.');
      }
      source = MIME_TO_KIND[docMime];
      const extracted = await this.extract(file.buffer, docMime, campaign?.releaseDate.toISOString().slice(0, 10));
      rows = extracted.rows.map((r, i) => aiRowToParsedRow(r, i + 1, tz));
      warnings = extracted.warnings;
      documentHashtags = extracted.documentHashtags;
    } else {
      rows = parseCsv(file.buffer, tz);
    }

    const errorCount = rows.filter((r) => r.error).length;
    const warningCount = rows.filter((r) => r.warning && !r.error).length;

    const imp = await this.prisma.planImport.create({
      data: {
        filename,
        status: 'PREVIEW',
        rowCount: rows.length,
        source,
        campaignId: campaign?.id,
        fileChecksum: checksum,
        errorCount,
        warningCount,
        createdById: user.id,
        rows: {
          create: rows.map((r) => ({
            rowIndex: r.rowIndex,
            date: r.date ?? new Date(),
            phase: r.phase,
            label: r.label,
            content: r.content,
            execution: r.execution,
            objective: r.objective,
            platforms: r.platforms,
            format: r.format,
            timeOfDay: r.timeOfDay,
            caption: r.caption,
            captionLanguage: r.captionLanguage,
            publishMode: r.publishMode,
            assetRef: r.assetRef,
            error: r.error,
            warning: r.warning,
            dedupeKey: r.dedupeKey,
          })),
        },
      },
      include: { rows: { orderBy: { rowIndex: 'asc' } } },
    });

    if (warnings.length || documentHashtags.length) {
      const value = { warnings, documentHashtags } as Prisma.InputJsonValue;
      await this.prisma.setting.upsert({
        where: { key: metaKey(imp.id) },
        create: { key: metaKey(imp.id), value },
        update: { value },
      });
    }

    await this.audit.log(user.id, 'planning.upload', 'PlanImport', imp.id, {
      rows: rows.length,
      errorCount,
      warningCount,
      source,
    });
    return { ...imp, meta: { warnings, documentHashtags } };
  }

  private async extract(buf: Buffer, mime: PlanDocMime, releaseDate?: string) {
    try {
      return await this.gemini.extractPlanDetailed(buf, mime, { releaseDate });
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`Plan extraction failed: ${msg}`);
      if (/^Gemini|GEMINI_API_KEY/.test(msg)) {
        throw new ServiceUnavailableException(`L’analyse IA a échoué : ${msg}. Réessayez dans un instant.`);
      }
      throw new BadRequestException(msg);
    }
  }

  /**
   * Commit a PREVIEW import in ONE transaction: claims the import first (so two simultaneous commits
   * cannot both run), then creates PlanEntry + legacy CampaignDay, and a DRAFT ContentItem for rows that
   * carry a caption. Rows with errors are skipped. Nothing here publishes anything.
   */
  @Post('imports/:id/commit')
  @Roles(Role.APPROVER)
  async commit(@Param('id') id: string, @Body() dto: CommitDto, @CurrentUser() user: AuthUser) {
    const imp = await this.prisma.planImport.findUnique({
      where: { id },
      include: { rows: { orderBy: { rowIndex: 'asc' } } },
    });
    if (!imp) throw new NotFoundException();
    if (imp.status === 'COMMITTED') throw new BadRequestException('Déjà validé');

    const campaign = await this.prisma.campaign.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!campaign) throw new BadRequestException('Aucune campagne. Créez-en une d’abord.');

    const validRows = imp.rows.filter((r) => !r.error);
    if (!validRows.length) throw new BadRequestException('Aucune ligne valide à valider');

    const addTags = [...new Set((dto?.addHashtags ?? []).map(cleanTag).filter(Boolean))];

    const result = await this.prisma.$transaction(
      async (tx) => {
        const claim = await tx.planImport.updateMany({
          where: { id, status: 'PREVIEW' },
          data: { status: 'COMMITTED', committedAt: new Date() },
        });
        if (claim.count === 0) throw new BadRequestException('Déjà validé');

        let created = 0;
        let skipped = 0;
        let drafts = 0;
        const seen = new Set<string>();

        for (const row of validRows) {
          if (row.dedupeKey) {
            if (seen.has(row.dedupeKey)) {
              skipped++;
              continue;
            }
            seen.add(row.dedupeKey);
            const dup = await tx.planImportRow.findFirst({
              where: {
                dedupeKey: row.dedupeKey,
                importId: { not: id },
                planEntryId: { not: null },
                import: { status: 'COMMITTED' },
              },
            });
            if (dup) {
              skipped++;
              continue;
            }
          }

          const entry = await tx.planEntry.create({
            data: {
              campaignId: campaign.id,
              importId: imp.id,
              date: row.date,
              timeOfDay: row.timeOfDay,
              phase: row.phase,
              label: row.label,
              content: row.content,
              execution: row.execution,
              objective: row.objective,
              platforms: row.platforms,
              format: row.format,
            },
          });
          await tx.planImportRow.update({ where: { id: row.id }, data: { planEntryId: entry.id } });

          // Legacy calendar day: match anywhere inside this local day so a seeded day is never duplicated.
          const dayEnd = new Date(row.date.getTime() + 24 * 3600_000);
          const existingDay = await tx.campaignDay.findFirst({
            where: { campaignId: campaign.id, date: { gte: row.date, lt: dayEnd } },
            select: { id: true },
          });
          if (!existingDay) {
            await tx.campaignDay.create({
              data: {
                campaignId: campaign.id,
                date: row.date,
                phase: row.phase,
                label: row.label,
                content: row.content,
                execution: row.execution,
                objective: row.objective,
                platforms: row.platforms,
                format: row.format,
              },
            });
          }

          // A caption written in the plan is kept as an editable DRAFT (never approved, never published).
          if (row.caption) {
            await tx.contentItem.create({
              data: {
                campaignId: campaign.id,
                planEntryId: entry.id,
                title: row.label.slice(0, 200),
                baseCaption: row.caption,
                captionLanguage: row.captionLanguage ?? undefined,
                defaultPublishMode: row.publishMode ?? 'MANUAL',
                hashtags: [],
                createdById: user.id,
              },
            });
            drafts++;
          }
          created++;
        }

        if (addTags.length) {
          const have = new Set(campaign.hashtags.map((h) => h.toLowerCase()));
          const merged = [...campaign.hashtags, ...addTags.filter((h) => !have.has(h.toLowerCase()))];
          await tx.campaign.update({ where: { id: campaign.id }, data: { hashtags: merged } });
        }

        return { created, skipped, drafts };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    await this.audit.log(user.id, 'planning.commit', 'PlanImport', id, { ...result, addedHashtags: addTags });
    return { ok: true, ...result };
  }

  @Delete('imports/:id')
  @Roles(Role.APPROVER)
  async deleteImport(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const imp = await this.prisma.planImport.findUnique({ where: { id } });
    if (!imp) throw new NotFoundException();
    await this.prisma.planImport.delete({ where: { id } });
    await this.prisma.setting.deleteMany({ where: { key: metaKey(id) } });
    await this.audit.log(user.id, 'planning.deleteImport', 'PlanImport', id);
    return { ok: true };
  }
}

@Module({ controllers: [PlanningController], imports: [] })
export class PlanningModule {}