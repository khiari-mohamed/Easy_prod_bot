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
  Patch,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  CaptionLanguage,
  Platform,
  PlanActionType,
  PlanImportRow,
  PlanProgress,
  PostFormat,
  Prisma,
  PublishMode,
  Role,
} from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { getEnv } from '../env';
import { cleanTag, GeminiService, PlanRow } from '../ai/gemini.service';
import { FeaturePolicyService } from '../features/feature-policy.service';
import {
  contentMatchesMime,
  DOCX_MIME,
  MAX_DOC_BYTES,
  mimeFromFilename,
  PDF_MIME,
  PlanDocMime,
  PPTX_MIME,
} from '../ai/document-text';
import { ACTION_TYPES, checkRow, normalizeTime, rowDedupeKey, toActionType } from './plan-rules';

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
  dateText: string | null;
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
  actionType: PlanActionType;
  sourceRef: string | null;
  sourceText: string | null;
  confidence: number | null;
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

function parseRow(col: (n: string) => string, rowIndex: number, tz: string): ParsedRow {
  const csvErrors: string[] = [];

  const dateStr = col('date');
  let date: Date | null = null;
  if (dateStr) {
    date = parseDay(dateStr, tz);
    if (!date) csvErrors.push(`Date invalide : "${dateStr}"`);
  }

  const rawPlatforms = col('platforms')
    .split(/[|,]/)
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
  const platforms = [...new Set(rawPlatforms.filter((p) => PLATFORMS.has(p)))] as Platform[];
  const unknown = rawPlatforms.filter((p) => !PLATFORMS.has(p));
  if (unknown.length) csvErrors.push(`Plateforme inconnue : ${unknown.join(', ')}`);

  const actionType = toActionType(col('action_type') || col('type') || 'POST');
  const rawFormat = col('format').toUpperCase();
  const format: PostFormat = FORMATS.has(rawFormat) ? (rawFormat as PostFormat) : 'REEL';
  const rawLang = col('caption_language').toUpperCase();
  const rawMode = col('publish_mode').toUpperCase();
  const caption = col('caption') || null;
  const assetRef = col('asset_ref') || col('asset') || null;
  const timeRaw = col('time_of_day') || col('time') || null;
  const timeOfDay = timeRaw ? normalizeTime(timeRaw) ?? timeRaw : null;
  const label = col('label') || col('title') || `Jour ${rowIndex}`;

  const check = checkRow({ label, date, dateText: dateStr || null, timeOfDay, actionType, platforms, format, caption, assetRef });
  const errors = [...csvErrors.filter((e) => !(date === null && e.startsWith('Date invalide'))), ...(check.error ? [check.error] : [])];
  return {
    rowIndex,
    date,
    dateText: dateStr || null,
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
    actionType,
    sourceRef: `Ligne ${rowIndex}`,
    sourceText: null,
    confidence: null,
    error: errors.length ? errors.join('; ') : null,
    warning: check.warning,
    dedupeKey: rowDedupeKey(date, timeOfDay, platforms, label, actionType),
  };
}

function aiRowToParsedRow(r: PlanRow, rowIndex: number, tz: string): ParsedRow {
  const date = r.date ? parseDay(r.date, tz) : null;
  const platforms = [...new Set((r.platforms ?? []).map((p) => p.toUpperCase()).filter((p) => PLATFORMS.has(p)))] as Platform[];
  const actionType = toActionType(r.actionType);
  const rawFormat = (r.format ?? '').toUpperCase();
  const format: PostFormat = FORMATS.has(rawFormat) ? (rawFormat as PostFormat) : 'REEL';
  const label = r.label || `Action ${rowIndex}`;
  const check = checkRow({
    label,
    date,
    dateText: r.dateText,
    timeOfDay: r.timeOfDay,
    actionType,
    platforms,
    format,
    caption: r.caption,
    assetRef: null,
    confidence: r.confidence,
  });
  return {
    rowIndex,
    date,
    dateText: r.dateText,
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
    actionType,
    sourceRef: r.sourceRef,
    sourceText: r.sourceText,
    confidence: r.confidence,
    error: check.error,
    warning: check.warning,
    dedupeKey: rowDedupeKey(date, r.timeOfDay ?? null, platforms, label, actionType),
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

/** Fields a reviewer may correct while an import is still a PREVIEW. Every field is optional. */
class RowDto {
  /** YYYY-MM-DD or DD/MM/YYYY. An empty string clears the date. */
  @IsOptional() @IsString() @MaxLength(40) date?: string;
  @IsOptional() @IsString() @MaxLength(8) timeOfDay?: string;
  @IsOptional() @IsString() @MaxLength(100) phase?: string;
  @IsOptional() @IsString() @MaxLength(200) label?: string;
  @IsOptional() @IsString() @MaxLength(2000) content?: string;
  @IsOptional() @IsString() @MaxLength(2000) execution?: string;
  @IsOptional() @IsString() @MaxLength(1000) objective?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsIn([...PLATFORMS], { each: true }) platforms?: string[];
  @IsOptional() @IsIn([...FORMATS]) format?: string;
  @IsOptional() @IsIn(ACTION_TYPES) actionType?: string;
  @IsOptional() @IsString() @MaxLength(2200) caption?: string;
  @IsOptional() @IsIn([...LANGUAGES, '']) captionLanguage?: string;
  @IsOptional() @IsIn([...MODES, '']) publishMode?: string;
  @IsOptional() @IsString() @MaxLength(300) assetRef?: string;
  /** The reviewer confirms this row matches the original document. */
  @IsOptional() @IsBoolean() verified?: boolean;
}

const PROGRESS: PlanProgress[] = ['PENDING', 'DONE', 'SKIPPED', 'BLOCKED'];

class ProgressDto {
  @IsIn(PROGRESS) progress!: PlanProgress;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

const metaKey = (importId: string) => `planimport:${importId}`;
const SOURCE_EXT: Record<ImportKind, string> = { CSV: 'csv', PDF: 'pdf', PPTX: 'pptx', DOCX: 'docx' };
const SOURCE_MIME: Record<ImportKind, string> = {
  CSV: 'text/csv',
  PDF: PDF_MIME,
  PPTX: PPTX_MIME,
  DOCX: DOCX_MIME,
};

/** The fields a reviewer can change, as stored in `original` (the extraction before any human edit). */
function snapshot(r: PlanImportRow): Record<string, unknown> {
  return {
    date: r.date ? r.date.toISOString() : null,
    dateText: r.dateText,
    timeOfDay: r.timeOfDay,
    phase: r.phase,
    label: r.label,
    content: r.content,
    execution: r.execution,
    objective: r.objective,
    platforms: r.platforms,
    format: r.format,
    actionType: r.actionType,
    caption: r.caption,
    captionLanguage: r.captionLanguage,
    publishMode: r.publishMode,
    assetRef: r.assetRef,
  };
}

type RowFields = Pick<
  PlanImportRow,
  | 'date'
  | 'dateText'
  | 'timeOfDay'
  | 'phase'
  | 'label'
  | 'content'
  | 'execution'
  | 'objective'
  | 'platforms'
  | 'format'
  | 'actionType'
  | 'caption'
  | 'captionLanguage'
  | 'publishMode'
  | 'assetRef'
>;

/** Applies a reviewer's edit on top of the current row, then re-runs every verification rule. */
export function mergeRow(cur: RowFields, dto: RowDto, tz: string) {
  let date = cur.date;
  let dateText = cur.dateText;
  if (dto.date !== undefined) {
    const typed = dto.date.trim();
    if (!typed) date = null;
    else {
      date = parseDay(typed, tz);
      if (!date) dateText = typed; // keep what they typed so the error message can quote it
    }
  }

  let timeOfDay = cur.timeOfDay;
  if (dto.timeOfDay !== undefined) {
    const typed = dto.timeOfDay.trim();
    timeOfDay = typed ? normalizeTime(typed) ?? typed : null;
  }

  const empty = (v: string | undefined) => (v === undefined ? undefined : v.trim() || null);
  const platforms = (dto.platforms ? [...new Set(dto.platforms)] : cur.platforms) as Platform[];
  const next = {
    date,
    dateText,
    timeOfDay,
    phase: dto.phase ?? cur.phase,
    label: dto.label !== undefined ? dto.label.trim() : cur.label,
    content: dto.content ?? cur.content,
    execution: dto.execution ?? cur.execution,
    objective: dto.objective ?? cur.objective,
    platforms,
    format: (dto.format ?? cur.format) as PostFormat,
    actionType: (dto.actionType ?? cur.actionType) as PlanActionType,
    caption: dto.caption !== undefined ? empty(dto.caption) ?? null : cur.caption,
    captionLanguage: (dto.captionLanguage !== undefined ? empty(dto.captionLanguage) ?? null : cur.captionLanguage) as CaptionLanguage | null,
    publishMode: (dto.publishMode !== undefined ? empty(dto.publishMode) ?? null : cur.publishMode) as PublishMode | null,
    assetRef: dto.assetRef !== undefined ? empty(dto.assetRef) ?? null : cur.assetRef,
  };
  // The extraction confidence no longer applies once a human has looked at the row.
  const check = checkRow({ ...next, confidence: null });
  return {
    ...next,
    error: check.error,
    warning: check.warning,
    dedupeKey: rowDedupeKey(next.date, next.timeOfDay, next.platforms, next.label, next.actionType),
  };
}

@Controller('planning')
export class PlanningController {
  private readonly log = new Logger(PlanningController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly gemini: GeminiService,
    private readonly policy: FeaturePolicyService,
  ) {}

  private sourceDir() {
    return join(getEnv().UPLOAD_DIR, 'plans');
  }

  private async campaignTz(): Promise<string> {
    const c = await this.prisma.campaign.findFirst({ orderBy: { createdAt: 'desc' }, select: { timezone: true } });
    return c?.timezone ?? DEFAULT_TZ;
  }

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
    return { ...imp, hasSource: !!imp.sourcePath, meta: meta?.value ?? null };
  }

  /** The original uploaded file, for side-by-side verification. Only PDFs are shown inline. */
  @Get('imports/:id/source')
  async source(@Param('id') id: string, @Res() res: Response) {
    const imp = await this.prisma.planImport.findUnique({ where: { id } });
    if (!imp?.sourcePath) throw new NotFoundException('Fichier original indisponible');
    const path = join(this.sourceDir(), basename(imp.sourcePath));
    const mime = imp.sourceMime ?? 'application/octet-stream';
    const inline = mime === PDF_MIME;
    res.setHeader('Content-Type', mime);
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(imp.filename)}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    const stream = createReadStream(path);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).end();
      else res.destroy();
    });
    stream.pipe(res);
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
      // Administration Center: AI extraction can be switched off. CSV/XLSX imports stay available, and an
      // extracted plan is ALWAYS verified row by row by a human (planning.verification is locked).
      await this.policy.assertHttp({ feature: 'planning.ai_extraction', campaignId: campaign?.id });
      if (!this.gemini.enabled) throw new BadRequestException('GEMINI_API_KEY est requise pour importer un PDF, PPTX ou Word.');
      if (!contentMatchesMime(file.buffer, docMime)) {
        throw new BadRequestException('Le contenu du fichier ne correspond pas à son extension.');
      }
      source = MIME_TO_KIND[docMime];

      // Campaign window: only used by the AI to expand explicitly recurring items.
      const firstDay = campaign
        ? await this.prisma.campaignDay.findFirst({ where: { campaignId: campaign.id }, orderBy: { date: 'asc' }, select: { date: true } })
        : null;
      const releaseMs = campaign?.releaseDate.getTime();
      const extracted = await this.extract(file.buffer, docMime, {
        releaseDate: campaign?.releaseDate.toISOString().slice(0, 10),
        windowStart: (firstDay?.date ?? new Date()).toISOString().slice(0, 10),
        windowEnd: releaseMs ? new Date(releaseMs + 30 * 24 * 3600_000).toISOString().slice(0, 10) : undefined,
      });
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
        sourceMime: SOURCE_MIME[source],
        rows: {
          create: rows.map((r) => {
            const base = {
              date: r.date,
              dateText: r.dateText,
              timeOfDay: r.timeOfDay,
              phase: r.phase,
              label: r.label,
              content: r.content,
              execution: r.execution,
              objective: r.objective,
              platforms: r.platforms,
              format: r.format,
              actionType: r.actionType,
              caption: r.caption,
              captionLanguage: r.captionLanguage,
              publishMode: r.publishMode,
              assetRef: r.assetRef,
            };
            return {
              rowIndex: r.rowIndex,
              ...base,
              sourceRef: r.sourceRef,
              sourceText: r.sourceText,
              confidence: r.confidence,
              error: r.error,
              warning: r.warning,
              dedupeKey: r.dedupeKey,
              // The untouched extraction, kept apart from the reviewer's corrections.
              original: { ...base, date: r.date ? r.date.toISOString() : null } as Prisma.InputJsonValue,
            };
          }),
        },
      },
      include: { rows: { orderBy: { rowIndex: 'asc' } } },
    });

    // Keep the original file so the reviewer can compare it with the extracted rows.
    let sourcePath: string | null = null;
    try {
      await mkdir(this.sourceDir(), { recursive: true });
      sourcePath = `${imp.id}.${SOURCE_EXT[source]}`;
      await writeFile(join(this.sourceDir(), sourcePath), file.buffer);
      await this.prisma.planImport.update({ where: { id: imp.id }, data: { sourcePath } });
    } catch (e) {
      sourcePath = null;
      this.log.warn(`Could not keep the original plan file: ${(e as Error).message}`);
    }

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
    return { ...imp, sourcePath, hasSource: !!sourcePath, meta: { warnings, documentHashtags } };
  }

  private async extract(buf: Buffer, mime: PlanDocMime, ctx: Parameters<GeminiService['extractPlanDetailed']>[2]) {
    try {
      return await this.gemini.extractPlanDetailed(buf, mime, ctx);
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`Plan extraction failed: ${msg}`);
      if (/^Gemini|GEMINI_API_KEY/.test(msg)) {
        throw new ServiceUnavailableException(`L’analyse IA a échoué : ${msg}. Réessayez dans un instant.`);
      }
      throw new BadRequestException(msg);
    }
  }

  // ---------------------------------------------------------------- verification stage

  private async editable(importId: string) {
    const imp = await this.prisma.planImport.findUnique({ where: { id: importId } });
    if (!imp) throw new NotFoundException();
    if (imp.status !== 'PREVIEW') throw new BadRequestException('Import déjà validé : modification impossible.');
    return imp;
  }

  private async refreshCounts(importId: string) {
    const [rowCount, errorCount, warningCount] = await Promise.all([
      this.prisma.planImportRow.count({ where: { importId } }),
      this.prisma.planImportRow.count({ where: { importId, error: { not: null } } }),
      this.prisma.planImportRow.count({ where: { importId, error: null, warning: { not: null } } }),
    ]);
    await this.prisma.planImport.update({ where: { id: importId }, data: { rowCount, errorCount, warningCount } });
  }

  /** Correct an extracted row. Every rule runs again; the original extraction is kept untouched. */
  @Patch('imports/:id/rows/:rowId')
  async editRow(@Param('id') id: string, @Param('rowId') rowId: string, @Body() dto: RowDto, @CurrentUser() user: AuthUser) {
    await this.editable(id);
    const row = await this.prisma.planImportRow.findFirst({ where: { id: rowId, importId: id } });
    if (!row) throw new NotFoundException();

    const { verified, ...fields } = dto;
    const changesContent = Object.values(fields).some((v) => v !== undefined);
    const merged = mergeRow(row, dto, await this.campaignTz());
    const updated = await this.prisma.planImportRow.update({
      where: { id: rowId },
      data: {
        ...merged,
        edited: row.edited || changesContent,
        original: row.original ?? (changesContent ? (snapshot(row) as Prisma.InputJsonValue) : undefined),
        // A row that still has an error can never count as verified.
        verified: merged.error ? false : (verified ?? row.verified),
      },
    });
    await this.refreshCounts(id);
    await this.audit.log(user.id, 'planning.editRow', 'PlanImportRow', rowId, { importId: id, fields: Object.keys(fields) });
    return updated;
  }

  /** Add an action the extraction missed. */
  @Post('imports/:id/rows')
  async addRow(@Param('id') id: string, @Body() dto: RowDto, @CurrentUser() user: AuthUser) {
    await this.editable(id);
    const blank: RowFields = {
      date: null,
      dateText: null,
      timeOfDay: null,
      phase: 'PHASE',
      label: '',
      content: '',
      execution: '',
      objective: '',
      platforms: [],
      format: 'REEL',
      actionType: 'POST',
      caption: null,
      captionLanguage: null,
      publishMode: null,
      assetRef: null,
    };
    const merged = mergeRow(blank, dto, await this.campaignTz());
    const last = await this.prisma.planImportRow.aggregate({ where: { importId: id }, _max: { rowIndex: true } });
    const row = await this.prisma.planImportRow.create({
      data: {
        importId: id,
        rowIndex: (last._max.rowIndex ?? 0) + 1,
        ...merged,
        sourceRef: 'Ajouté manuellement',
        edited: true,
        verified: !merged.error && dto.verified === true,
      },
    });
    await this.refreshCounts(id);
    await this.audit.log(user.id, 'planning.addRow', 'PlanImportRow', row.id, { importId: id });
    return row;
  }

  @Delete('imports/:id/rows/:rowId')
  async deleteRow(@Param('id') id: string, @Param('rowId') rowId: string, @CurrentUser() user: AuthUser) {
    await this.editable(id);
    const gone = await this.prisma.planImportRow.deleteMany({ where: { id: rowId, importId: id } });
    if (gone.count === 0) throw new NotFoundException();
    await this.refreshCounts(id);
    await this.audit.log(user.id, 'planning.deleteRow', 'PlanImportRow', rowId, { importId: id });
    return { ok: true };
  }

  /** Put a row back exactly as the extraction produced it. */
  @Post('imports/:id/rows/:rowId/reset')
  async resetRow(@Param('id') id: string, @Param('rowId') rowId: string, @CurrentUser() user: AuthUser) {
    await this.editable(id);
    const row = await this.prisma.planImportRow.findFirst({ where: { id: rowId, importId: id } });
    if (!row) throw new NotFoundException();
    const o = row.original as Record<string, any> | null;
    if (!o) return row; // never edited
    const restored: RowFields = {
      date: o.date ? new Date(o.date) : null,
      dateText: o.dateText ?? null,
      timeOfDay: o.timeOfDay ?? null,
      phase: o.phase ?? '',
      label: o.label ?? '',
      content: o.content ?? '',
      execution: o.execution ?? '',
      objective: o.objective ?? '',
      platforms: o.platforms ?? [],
      format: o.format ?? 'REEL',
      actionType: o.actionType ?? 'POST',
      caption: o.caption ?? null,
      captionLanguage: o.captionLanguage ?? null,
      publishMode: o.publishMode ?? null,
      assetRef: o.assetRef ?? null,
    };
    const merged = mergeRow(restored, {}, await this.campaignTz());
    const updated = await this.prisma.planImportRow.update({
      where: { id: rowId },
      data: { ...merged, edited: false, verified: false, original: Prisma.DbNull },
    });
    await this.refreshCounts(id);
    await this.audit.log(user.id, 'planning.resetRow', 'PlanImportRow', rowId, { importId: id });
    return updated;
  }

  /** Mark every row without an error as checked against the document. */
  @Post('imports/:id/verify-all')
  async verifyAll(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.editable(id);
    const r = await this.prisma.planImportRow.updateMany({ where: { importId: id, error: null }, data: { verified: true } });
    await this.audit.log(user.id, 'planning.verifyAll', 'PlanImport', id, { rows: r.count });
    return { ok: true, verified: r.count };
  }

  // ---------------------------------------------------------------- commit

  /**
   * Approve a verified PREVIEW import in ONE transaction. It refuses while any row still has an error or
   * has not been marked as verified, so nothing is silently dropped or imported unchecked.
   * POST rows become plan entries (plus the legacy calendar day and a DRAFT content item when a caption
   * was supplied). Comments, engagement, sponsoring, preparation and reporting become plan entries only:
   * tasks on the calendar, never social posts. Nothing here publishes anything.
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

    if (!imp.rows.length) throw new BadRequestException('Aucune ligne à valider');
    const withError = imp.rows.filter((r) => r.error);
    if (withError.length) {
      throw new BadRequestException(
        `${withError.length} ligne(s) en erreur (n° ${withError.map((r) => r.rowIndex).join(', ')}) : corrigez-les d’après le document ou supprimez-les avant de valider.`,
      );
    }
    const unverified = imp.rows.filter((r) => !r.verified);
    if (unverified.length) {
      throw new BadRequestException(
        `${unverified.length} ligne(s) non vérifiée(s) (n° ${unverified.map((r) => r.rowIndex).join(', ')}) : comparez-les avec le document puis cochez « Vérifié ».`,
      );
    }
    const validRows = imp.rows;

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
        let tasks = 0;
        const seen = new Set<string>();

        for (const row of validRows) {
          const date = row.date!; // rows without a date carry an error and were refused above
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

          const isPost = row.actionType === 'POST';
          const entry = await tx.planEntry.create({
            data: {
              campaignId: campaign.id,
              importId: imp.id,
              date,
              timeOfDay: row.timeOfDay,
              phase: row.phase,
              label: row.label,
              content: row.content,
              execution: row.execution,
              objective: row.objective,
              platforms: row.platforms,
              format: row.format,
              actionType: row.actionType,
              text: row.caption,
              sourceRef: row.sourceRef,
              sourceText: row.sourceText,
            },
          });
          await tx.planImportRow.update({ where: { id: row.id }, data: { planEntryId: entry.id } });

          if (!isPost) {
            tasks++;
            created++;
            continue;
          }

          // Legacy calendar day: match anywhere inside this local day so a seeded day is never duplicated.
          const dayEnd = new Date(date.getTime() + 24 * 3600_000);
          const existingDay = await tx.campaignDay.findFirst({
            where: { campaignId: campaign.id, date: { gte: date, lt: dayEnd } },
            select: { id: true },
          });
          if (!existingDay) {
            await tx.campaignDay.create({
              data: {
                campaignId: campaign.id,
                date,
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

        return { created, skipped, drafts, tasks };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    await this.audit.log(user.id, 'planning.commit', 'PlanImport', id, { ...result, addedHashtags: addTags });
    return { ok: true, ...result };
  }

  // ---------------------------------------------------------------- calendar side

  /** Approved plan actions (posts AND tasks) for the calendar. `from` / `to` are YYYY-MM-DD, inclusive. */
  @Get('entries')
  async entries(@Query('from') from?: string, @Query('to') to?: string) {
    const tz = await this.campaignTz();
    const start = from ? parseDay(from, tz) : null;
    const end = to ? parseDay(to, tz) : null;
    return this.prisma.planEntry.findMany({
      where: {
        ...(start || end
          ? { date: { ...(start ? { gte: start } : {}), ...(end ? { lt: new Date(end.getTime() + 24 * 3600_000) } : {}) } }
          : {}),
      },
      orderBy: [{ date: 'asc' }, { timeOfDay: 'asc' }],
      take: 2000,
      include: { contentItems: { select: { id: true, approvalStatus: true } } },
    });
  }

  /** Track an approved plan action: pending, done, skipped or blocked. */
  @Patch('entries/:id/progress')
  async setProgress(@Param('id') id: string, @Body() dto: ProgressDto, @CurrentUser() user: AuthUser) {
    const entry = await this.prisma.planEntry.findUnique({ where: { id }, select: { id: true } });
    if (!entry) throw new NotFoundException();
    const updated = await this.prisma.planEntry.update({
      where: { id },
      data: {
        progress: dto.progress,
        progressNote: dto.note?.trim() || null,
        progressAt: dto.progress === 'PENDING' ? null : new Date(),
        progressById: dto.progress === 'PENDING' ? null : user.id,
      },
    });
    await this.audit.log(user.id, 'planning.progress', 'PlanEntry', id, { progress: dto.progress });
    return updated;
  }

  @Delete('imports/:id')
  @Roles(Role.APPROVER)
  async deleteImport(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const imp = await this.prisma.planImport.findUnique({ where: { id } });
    if (!imp) throw new NotFoundException();
    await this.prisma.planImport.delete({ where: { id } });
    await this.prisma.setting.deleteMany({ where: { key: metaKey(id) } });
    if (imp.sourcePath) await unlink(join(this.sourceDir(), basename(imp.sourcePath))).catch(() => undefined);
    await this.audit.log(user.id, 'planning.deleteImport', 'PlanImport', id);
    return { ok: true };
  }
}

@Module({ controllers: [PlanningController], imports: [] })
export class PlanningModule {}