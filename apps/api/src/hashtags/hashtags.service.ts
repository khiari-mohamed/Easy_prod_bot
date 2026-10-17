import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CaptionLanguage, Hashtag, HashtagOrigin, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../auth/auth.types';
import { CreateHashtagsDto, ListHashtagsQuery, UpdateHashtagDto } from './hashtags.dto';
import { displayTag, isValidTag, normalizeTag, splitTags } from './hashtag-utils';

export interface TagEntry {
  display: string;
  origin: HashtagOrigin;
  language?: CaptionLanguage | null;
  category?: string | null;
  createdById?: string | null;
}

@Injectable()
export class HashtagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Idempotent bulk upsert by normalised tag. Existing rows are never overwritten
   * (an AI suggestion must not downgrade a tag a human typed). Returns normalised -> row.
   */
  async upsertMany(entries: TagEntry[]): Promise<Map<string, Hashtag>> {
    const clean = new Map<string, TagEntry & { normalized: string }>();
    for (const e of entries) {
      const normalized = normalizeTag(e.display);
      if (!isValidTag(normalized) || clean.has(normalized)) continue;
      clean.set(normalized, { ...e, normalized, display: displayTag(e.display) });
    }
    if (!clean.size) return new Map();
    await this.prisma.hashtag.createMany({
      data: [...clean.values()].map((e) => ({
        normalizedTag: e.normalized,
        displayTag: e.display,
        origin: e.origin,
        language: e.language ?? null,
        category: e.category ?? null,
        createdById: e.createdById ?? null,
      })),
      skipDuplicates: true,
    });
    const rows = await this.prisma.hashtag.findMany({ where: { normalizedTag: { in: [...clean.keys()] } } });
    return new Map(rows.map((r) => [r.normalizedTag, r]));
  }

  async list(q: ListHashtagsQuery) {
    const where: Prisma.HashtagWhereInput = {
      language: q.language,
      origin: q.origin,
      category: q.category,
      blocked: q.blocked,
      ...(q.q ? { normalizedTag: { contains: normalizeTag(q.q) } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.hashtag.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        take: q.take ?? 50,
        skip: q.skip ?? 0,
        include: { _count: { select: { usages: true, suggestions: true } } },
      }),
      this.prisma.hashtag.count({ where }),
    ]);
    return { total, items };
  }

  /** Manual entry: always available, never gated (the admin switch only governs the AI). */
  async createManual(dto: CreateHashtagsDto, user: AuthUser) {
    const raw = dto.tags.flatMap(splitTags);
    const rejected: string[] = [];
    const entries: TagEntry[] = [];
    for (const t of raw) {
      if (isValidTag(normalizeTag(t))) {
        entries.push({
          display: t,
          origin: 'MANUAL',
          language: dto.language,
          category: dto.category,
          createdById: user.id,
        });
      } else rejected.push(t);
    }
    if (!entries.length) throw new BadRequestException('Aucun hashtag valide (2 à 60 caractères, lettres/chiffres).');

    const keys = [...new Set(entries.map((e) => normalizeTag(e.display)))];
    const before = new Set(
      (await this.prisma.hashtag.findMany({ where: { normalizedTag: { in: keys } }, select: { normalizedTag: true } })).map(
        (r) => r.normalizedTag,
      ),
    );
    const map = await this.upsertMany(entries);

    // Fill the optional metadata of an existing tag only where it is still empty.
    for (const h of map.values()) {
      if (!before.has(h.normalizedTag)) continue;
      const patch: Prisma.HashtagUpdateInput = {};
      if (dto.language && !h.language) patch.language = dto.language;
      if (dto.category && !h.category) patch.category = dto.category;
      if (dto.notes && !h.notes) patch.notes = dto.notes;
      if (Object.keys(patch).length) await this.prisma.hashtag.update({ where: { id: h.id }, data: patch });
    }
    if (dto.notes) {
      await this.prisma.hashtag.updateMany({
        where: { normalizedTag: { in: keys }, notes: null, createdAt: { gte: new Date(Date.now() - 60_000) } },
        data: { notes: dto.notes },
      });
    }
    await this.audit.log(user.id, 'hashtag.create', 'Hashtag', undefined, { tags: keys });
    return {
      created: [...map.values()].filter((h) => !before.has(h.normalizedTag)),
      existing: [...map.values()].filter((h) => before.has(h.normalizedTag)),
      rejected,
    };
  }

  async update(id: string, dto: UpdateHashtagDto, user: AuthUser) {
    const current = await this.prisma.hashtag.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Hashtag introuvable');
    if (dto.blocked !== undefined && user.role !== Role.ADMIN && user.role !== Role.APPROVER) {
      throw new ForbiddenException('Seul un approbateur peut bloquer ou débloquer un hashtag.');
    }
    if (dto.displayTag !== undefined && normalizeTag(dto.displayTag) !== current.normalizedTag) {
      throw new BadRequestException('Seule la casse ou les accents peuvent changer : le hashtag doit rester le même.');
    }
    const updated = await this.prisma.hashtag.update({
      where: { id },
      data: {
        displayTag: dto.displayTag !== undefined ? displayTag(dto.displayTag) : undefined,
        language: dto.language,
        category: dto.category,
        notes: dto.notes,
        blocked: dto.blocked,
        blockedReason: dto.blocked === false ? null : dto.blockedReason,
      },
    });
    await this.audit.log(user.id, 'hashtag.update', 'Hashtag', id, dto);
    return updated;
  }

  /** Explainable per-hashtag numbers for the admin UI. */
  async stats(id: string) {
    const tag = await this.prisma.hashtag.findUnique({ where: { id } });
    if (!tag) throw new NotFoundException('Hashtag introuvable');
    const [usages, perf, feedback] = await Promise.all([
      this.prisma.hashtagUsage.groupBy({ by: ['platform'], where: { hashtagId: id }, _count: { _all: true } }),
      this.prisma.hashtagPerformance.findMany({ where: { hashtagId: id }, orderBy: { measuredAt: 'desc' }, take: 50 }),
      this.prisma.hashtagSuggestion.groupBy({
        by: ['status'],
        where: { hashtagId: id, status: { in: ['APPROVED', 'REJECTED'] } },
        _count: { _all: true },
      }),
    ]);
    const rates = perf
      .filter((p) => p.engagements !== null && (p.reach ?? p.impressions ?? 0) > 0)
      .map((p) => (p.engagements as number) / ((p.reach ?? p.impressions) as number));
    return {
      tag,
      usageByPlatform: usages.map((u) => ({ platform: u.platform, count: u._count._all })),
      feedback: Object.fromEntries(feedback.map((f) => [f.status, f._count._all])),
      measuredPosts: perf.length,
      avgEngagementRate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
      recent: perf.slice(0, 10),
    };
  }
}