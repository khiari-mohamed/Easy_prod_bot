import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CaptionLanguage, Platform, Prisma, Role, SuggestionStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../auth/auth.types';
import { GeminiService } from '../ai/gemini.service';
import { defaultLanguage } from '../ai/ai.service';
import { FeaturePolicyService } from '../features/feature-policy.service';
import { ContentService } from '../content/content.service';
import { PostsService } from '../posts/posts.service';
import { HashtagsService } from '../hashtags/hashtags.service';
import { HashtagRankingService } from '../hashtags/hashtag-ranking.service';
import { displayTag, normalizeTag } from '../hashtags/hashtag-utils';
import { TrendsService } from '../trends/trends.service';
import { buildCaptionPrompt } from './caption-prompt.builder';
import { checkFacts, lintCaption } from './caption-language';
import {
  AI_FEATURE,
  DEFAULT_TONES,
  PLATFORM_LIMITS,
  PROMPT_VERSION,
  ScriptPref,
  frenchDateVariants,
} from './caption-rules';
import { GenerationFormatError, ValidationContext, ValidatedVariant, parseGeneration, validateVariant } from './caption-validator';
import {
  ApplySuggestionDto,
  ApproveSuggestionDto,
  EditSuggestionDto,
  FeedbackDto,
  GenerateCaptionsDto,
  ListSuggestionsQuery,
  RejectSuggestionDto,
} from './captions.dto';

const INCLUDE = {
  hashtagSuggestions: { include: { hashtag: true }, orderBy: { rank: 'asc' as const } },
  reviews: {
    orderBy: { reviewedAt: 'desc' as const },
    take: 5,
    include: { reviewer: { select: { id: true, name: true } } },
  },
  contentItem: { select: { id: true, title: true, campaignId: true, planEntryId: true, baseCaption: true } },
} satisfies Prisma.CaptionSuggestionInclude;

type Suggestion = Prisma.CaptionSuggestionGetPayload<{ include: typeof INCLUDE }>;
type Meta = Record<string, unknown>;

const REVIEWABLE: SuggestionStatus[] = ['GENERATED', 'NEEDS_REVIEW'];
const EDITABLE: SuggestionStatus[] = ['GENERATED', 'NEEDS_REVIEW', 'APPROVED'];
const flat = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
const metaOf = (s: { metadata: Prisma.JsonValue | null }): Meta => ((s.metadata ?? {}) as Meta);

/** What the web app receives: effective text and whether the approval is still valid are computed server-side. */
function present(s: Suggestion) {
  const meta = metaOf(s);
  return {
    ...s,
    effectiveText: s.editedText ?? s.text,
    approvalCurrent: s.status === 'APPROVED' && s.approvedRevision === s.revision,
    planOriginal: (meta.planOriginal as string | null | undefined) ?? null,
    missingInfo: (meta.missingInfo as string[] | undefined) ?? [],
    hashtags: s.hashtagSuggestions
      .filter((h) => h.status !== 'REJECTED')
      .map((h) => ({
        id: h.hashtag.id,
        tag: h.hashtag.displayTag,
        normalized: h.hashtag.normalizedTag,
        rank: h.rank,
        reason: h.reason,
        status: h.status,
        origin: h.hashtag.origin,
      })),
    removedHashtags: s.hashtagSuggestions.filter((h) => h.status === 'REJECTED').map((h) => h.hashtag.displayTag),
  };
}

@Injectable()
export class CaptionsService {
  private readonly log = new Logger(CaptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly gemini: GeminiService,
    private readonly policy: FeaturePolicyService,
    private readonly content: ContentService,
    private readonly posts: PostsService,
    private readonly hashtags: HashtagsService,
    private readonly ranking: HashtagRankingService,
    private readonly trends: TrendsService,
  ) {}

  // ================================================================ generation

  async generate(dto: GenerateCaptionsDto, user: AuthUser) {
    const platforms = [...new Set(dto.platforms)];

    const item = dto.contentItemId
      ? await this.prisma.contentItem.findUnique({
          where: { id: dto.contentItemId },
          include: { planEntry: true, assets: { include: { asset: true }, orderBy: { order: 'asc' } } },
        })
      : null;
    if (dto.contentItemId && !item) throw new NotFoundException('Contenu introuvable');
    const planEntry =
      item?.planEntry ?? (dto.planEntryId ? await this.prisma.planEntry.findUnique({ where: { id: dto.planEntryId } }) : null);
    if (dto.planEntryId && !planEntry) throw new NotFoundException('Entrée de planning introuvable');

    const campaign = item?.campaignId || planEntry?.campaignId
      ? await this.prisma.campaign.findUnique({ where: { id: (item?.campaignId ?? planEntry?.campaignId) as string } })
      : await this.prisma.campaign.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!campaign) throw new NotFoundException('Aucune campagne configurée');

    // Every platform is checked against the policy BEFORE any model call.
    for (const platform of platforms) {
      await this.policy.assertHttp({ feature: AI_FEATURE.CAPTIONS, campaignId: campaign.id, platform, action: 'GENERATE' });
    }
    if (!this.gemini.enabled) throw new ServiceUnavailableException('GEMINI_API_KEY manquante : génération indisponible.');

    const language: CaptionLanguage = dto.language ?? item?.captionLanguage ?? defaultLanguage(platforms[0]);
    const script: ScriptPref = dto.script ?? 'AUTO';
    const tones = [...new Set((dto.tones?.length ? dto.tones : DEFAULT_TONES).map((t) => t.toLowerCase()))];

    // The exact caption of the plan (or one already written) is NEVER overwritten: it is passed as a fact lock
    // and returned next to the suggestions so the reviewer sees both.
    const planCaption = planEntry?.text?.trim() || null;
    const suppliedCaption = planCaption || item?.baseCaption?.trim() || dto.baseCaption?.trim() || null;

    const media = (item?.assets ?? []).map((a) => ({
      name: a.asset.name,
      kind: a.asset.kind,
      durationSecs: a.asset.durationSecs,
      tags: a.asset.tags,
    }));
    const format = planEntry?.format ?? null;

    const allowedFacts = [
      campaign.titleLatin,
      campaign.titleArabic,
      campaign.brief,
      campaign.hashtags.join(' '),
      ...frenchDateVariants(campaign.releaseDate),
      planEntry && [planEntry.label, planEntry.content, planEntry.execution, planEntry.objective, planEntry.text, planEntry.sourceText, planEntry.timeOfDay].filter(Boolean).join(' '),
      item && `${item.title} ${item.baseCaption}`,
      dto.brief,
      dto.baseCaption,
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 8000);

    const blocked = new Set(
      (await this.prisma.hashtag.findMany({ where: { blocked: true }, select: { normalizedTag: true } })).map((h) => h.normalizedTag),
    );

    const batchId = randomUUID();
    const created: ReturnType<typeof present>[] = [];
    const notes: string[] = [];

    for (const platform of platforms) {
      const ask = async (feature: string) =>
        (await this.policy.evaluate({ feature, campaignId: campaign.id, platform, action: 'GENERATE' })).allowed;
      const [allowAiHashtags, learning, trendsOn] = await Promise.all([
        ask(AI_FEATURE.HASHTAGS),
        ask(AI_FEATURE.LEARNING),
        ask(AI_FEATURE.TRENDS),
      ]);

      const context = [item?.title, planEntry?.label, planEntry?.content, planEntry?.objective, suppliedCaption, dto.brief]
        .filter(Boolean)
        .join('\n');

      // Ranked candidates (relevance + performance + feedback + trends, each only if its feature is on)
      const ranked = allowAiHashtags
        ? await this.ranking.recommendFor({ platform, language, campaignId: campaign.id, context, limit: 14 })
        : { items: [], flags: { performance: false, feedback: false, trends: false } };
      const verifiedTrends = trendsOn ? await this.trends.usable(platform, 10) : [];
      const examples = learning ? await this.approvedExamples(campaign.id, platform, language, 4) : [];

      const prompt = buildCaptionPrompt({
        platform,
        language,
        script,
        tones,
        format,
        campaign: {
          titleLatin: campaign.titleLatin,
          titleArabic: campaign.titleArabic,
          releaseDate: campaign.releaseDate.toISOString().slice(0, 10),
          brief: campaign.brief,
          officialHashtags: campaign.hashtags,
        },
        plan: planEntry
          ? {
              label: planEntry.label,
              phase: planEntry.phase,
              content: planEntry.content,
              execution: planEntry.execution,
              objective: planEntry.objective,
              timeOfDay: planEntry.timeOfDay,
            }
          : null,
        contentTitle: item?.title ?? null,
        suppliedCaption,
        media,
        extraBrief: dto.brief,
        approvedExamples: examples,
        hashtagCandidates: ranked.items.map((h) => ({ tag: h.tag, score: h.score, reason: h.reasons[0] ?? 'candidat' })),
        trends: verifiedTrends.map((t) => ({
          tag: t.tag,
          source: t.source,
          region: t.region,
          observedAt: t.observedAt.toISOString().slice(0, 10),
        })),
        allowAiHashtags,
      });

      const vctx: ValidationContext = {
        platform,
        language,
        allowedFacts,
        officialTags: new Set(campaign.hashtags.map(normalizeTag)),
        libraryTags: new Set(ranked.items.map((h) => h.normalizedTag)),
        trendTags: new Set(verifiedTrends.map((t) => t.normalizedTag)),
        blockedTags: blocked,
        allowAiHashtags,
      };

      const { variants, model } = await this.callModel(prompt, vctx, tones.length);

      // Skip variants identical to one that is already waiting for review or approved for this slot.
      const existing = item
        ? await this.prisma.captionSuggestion.findMany({
            where: { contentItemId: item.id, platform, language, status: 'APPROVED' },
            select: { text: true, editedText: true },
          })
        : [];
      const known = new Set(existing.flatMap((e) => [flat(e.text), flat(e.editedText ?? e.text)]));
      const fresh = variants.filter((v) => !known.has(flat(v.caption)));
      if (fresh.length < variants.length) notes.push(`${platform} : ${variants.length - fresh.length} variante(s) identique(s) à une suggestion existante ignorée(s).`);

      const tagMap = await this.hashtags.upsertMany(
        fresh.flatMap((v) =>
          v.hashtags.map((t) => ({
            display: t.display,
            origin: t.source === 'TREND' ? ('TREND_SOURCE' as const) : t.source === 'NEW' ? ('AI_GENERATED' as const) : ('MANUAL' as const),
            language,
          })),
        ),
      );

      const rows = await this.prisma.$transaction(async (tx) => {
        // New unreviewed suggestions replace the old unreviewed ones of the same slot.
        // APPROVED ones are never touched: a human validated them.
        if (item) {
          await tx.captionSuggestion.updateMany({
            where: { contentItemId: item.id, platform, language, status: { in: ['GENERATED', 'NEEDS_REVIEW'] } },
            data: { status: 'SUPERSEDED' },
          });
        }
        const out: Suggestion[] = [];
        for (const v of fresh) {
          out.push(
            await tx.captionSuggestion.create({
              data: {
                contentItemId: item?.id ?? null,
                platform,
                language,
                text: v.caption,
                tone: v.tone,
                status: v.warnings.length ? 'NEEDS_REVIEW' : 'GENERATED',
                model,
                promptVersion: PROMPT_VERSION,
                warnings: v.warnings,
                batchId,
                metadata: {
                  requestedById: user.id,
                  campaignId: campaign.id,
                  planEntryId: planEntry?.id ?? null,
                  planOriginal: suppliedCaption,
                  planCaptionExact: !!planCaption,
                  missingInfo: v.missingInfo,
                  allowedFacts,
                  signals: {
                    aiHashtags: allowAiHashtags,
                    learning,
                    performance: ranked.flags.performance,
                    trends: verifiedTrends.length,
                    examplesUsed: examples.length,
                  },
                  trendTagsUsed: verifiedTrends.map((t) => t.tag),
                } as Prisma.InputJsonValue,
                hashtagSuggestions: {
                  create: v.hashtags
                    .filter((t) => tagMap.has(t.normalized))
                    .map((t, i) => ({
                      hashtagId: (tagMap.get(t.normalized) as { id: string }).id,
                      rank: i,
                      reason: t.reason || (t.source === 'OFFICIAL' ? 'Hashtag officiel' : null),
                    })),
                },
              },
              include: INCLUDE,
            }),
          );
        }
        return out;
      });
      created.push(...rows.map(present));
    }

    await this.audit.log(user.id, 'caption.generate', 'CaptionSuggestion', batchId, {
      contentItemId: item?.id ?? null,
      platforms,
      language,
      count: created.length,
    });
    if (!created.length) notes.push('Aucune nouvelle suggestion : toutes les variantes existaient déjà.');
    return { batchId, suggestions: created, notes };
  }

  /** One call + one corrective retry when the JSON shape is wrong. Transient errors are retried inside GeminiService. */
  private async callModel(prompt: string, vctx: ValidationContext, n: number) {
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const p =
          attempt === 0
            ? prompt
            : `${prompt}\n\n## CORRECTION\nYour previous reply was rejected: ${lastError}. Reply again with ONLY the JSON object in the required shape.`;
        const { json, model } = await this.gemini.generateJson(p, attempt === 0 ? 0.8 : 0.4);
        const variants: ValidatedVariant[] = parseGeneration(json, n).map((v) => validateVariant(v, vctx));
        return { variants, model };
      } catch (e) {
        lastError = (e as Error).message;
        const formatProblem = e instanceof GenerationFormatError || /no JSON|JSON/i.test(lastError);
        if (!formatProblem) throw new BadGatewayException(`Le modèle est indisponible : ${lastError}`);
        this.log.warn(`Caption JSON rejected (attempt ${attempt + 1}): ${lastError}`);
      }
    }
    throw new BadGatewayException(`Le modèle n’a pas renvoyé un JSON valide : ${lastError}`);
  }

  /**
   * Retrieval for "learning from feedback": ONLY approved suggestions, never rejected or superseded ones.
   * Text a human corrected before approving is preferred, then recent ones.
   */
  private async approvedExamples(campaignId: string, platform: Platform, language: CaptionLanguage, take: number) {
    const rows = await this.prisma.captionSuggestion.findMany({
      where: {
        status: 'APPROVED',
        platform,
        language,
        finalText: { not: null },
        OR: [{ contentItem: { campaignId } }, { contentItemId: null }],
      },
      orderBy: { approvedAt: 'desc' },
      take: 20,
      include: { feedbacks: { select: { rating: true } } },
    });
    return rows
      .filter((r) => r.approvedRevision === r.revision && r.finalText)
      .map((r) => {
        const ratings = r.feedbacks.map((f) => f.rating);
        const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 3;
        const corrected = flat(r.finalText as string) !== flat(r.text);
        return {
          rank: avg + (corrected ? 1.5 : 0),
          text: r.finalText as string,
          hashtags: ((metaOf(r).approvedHashtags as string[] | undefined) ?? []).slice(0, 6),
          tone: r.tone,
          humanCorrected: corrected,
        };
      })
      .sort((a, b) => b.rank - a.rank)
      .slice(0, take);
  }

  // ================================================================ reading

  async list(q: ListSuggestionsQuery) {
    const rows = await this.prisma.captionSuggestion.findMany({
      where: {
        contentItemId: q.contentItemId,
        batchId: q.batchId,
        platform: q.platform,
        language: q.language,
        status: q.status,
      },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: q.take ?? 60,
    });
    return rows.map(present);
  }

  async get(id: string) {
    return present(await this.load(id));
  }

  private async load(id: string): Promise<Suggestion> {
    const s = await this.prisma.captionSuggestion.findUnique({ where: { id }, include: INCLUDE });
    if (!s) throw new NotFoundException('Suggestion introuvable');
    return s;
  }

  private campaignOf(s: Suggestion): string | undefined {
    return s.contentItem?.campaignId ?? ((metaOf(s).campaignId as string | undefined) ?? undefined);
  }

  private requireApprover(user: AuthUser) {
    if (user.role !== Role.ADMIN && user.role !== Role.APPROVER) {
      throw new ForbiddenException('Seul un approbateur peut valider une légende.');
    }
  }

  // ================================================================ edit (invalidates approval)

  async edit(id: string, dto: EditSuggestionDto, user: AuthUser) {
    if (dto.text === undefined && dto.hashtags === undefined) throw new BadRequestException('Rien à modifier.');
    const s = await this.load(id);
    if (!EDITABLE.includes(s.status)) throw new ConflictException(`Une suggestion « ${s.status} » ne peut plus être modifiée.`);
    if (s.revision !== dto.revision) {
      throw new ConflictException('Cette suggestion a changé entre-temps. Rechargez-la avant de modifier.');
    }
    await this.policy.assertHttp({ feature: AI_FEATURE.CAPTIONS, campaignId: this.campaignOf(s), platform: s.platform, action: 'EDIT' });

    const text = dto.text !== undefined ? dto.text.trim() : (s.editedText ?? s.text);
    if (!text) throw new BadRequestException('Le texte ne peut pas être vide.');
    const lim = PLATFORM_LIMITS[s.platform];

    const wanted = dto.hashtags
      ? [...new Map(dto.hashtags.map((t) => [normalizeTag(t), t] as const).filter(([n]) => n.length >= 2)).entries()]
      : null;
    if (wanted && wanted.length > lim.hashtags) throw new BadRequestException(`${s.platform} accepte au plus ${lim.hashtags} hashtags.`);

    const meta = metaOf(s);
    const warnings = [
      ...lintCaption(text, s.language),
      ...checkFacts(text, (meta.allowedFacts as string | undefined) ?? ''),
      ...(text.length > lim.caption ? [`La légende dépasse ${lim.caption} caractères (${s.platform}).`] : []),
    ];
    const wasApproved = s.status === 'APPROVED';
    const { approvedHashtags: _dropped, ...metaWithoutApproval } = meta;

    // Hashtags the human adds go through the library as MANUAL (a human typed them).
    const tagMap = wanted
      ? await this.hashtags.upsertMany(
          wanted.map(([, display]) => ({ display, origin: 'MANUAL' as const, language: s.language, createdById: user.id })),
        )
      : null;

    await this.prisma.$transaction(async (tx) => {
      const res = await tx.captionSuggestion.updateMany({
        where: { id, revision: dto.revision, status: { in: EDITABLE } },
        data: {
          editedText: text,
          revision: { increment: 1 },
          status: 'NEEDS_REVIEW',
          warnings: [...new Set(warnings)],
          // Editing ALWAYS invalidates a previous approval.
          finalText: null,
          approvedById: null,
          approvedAt: null,
          approvedRevision: null,
          metadata: metaWithoutApproval as Prisma.InputJsonValue,
        },
      });
      if (res.count === 0) throw new ConflictException('Cette suggestion a changé entre-temps. Rechargez-la.');

      if (wanted && tagMap) {
        const keep = new Set(wanted.map(([n]) => n));
        for (const hs of s.hashtagSuggestions) {
          // A tag the human removed is an explicit negative signal for the ranking.
          if (!keep.has(hs.hashtag.normalizedTag) && hs.status !== 'REJECTED') {
            await tx.hashtagSuggestion.update({ where: { id: hs.id }, data: { status: 'REJECTED' } });
          }
        }
        let rank = 0;
        for (const [n] of wanted) {
          const h = tagMap.get(n);
          if (!h) continue;
          const current = s.hashtagSuggestions.find((x) => x.hashtagId === h.id);
          if (current) {
            await tx.hashtagSuggestion.update({ where: { id: current.id }, data: { status: 'GENERATED', rank } });
          } else {
            await tx.hashtagSuggestion.create({
              data: { captionSuggestionId: id, hashtagId: h.id, rank, reason: 'Ajouté par un relecteur' },
            });
          }
          rank++;
        }
      }
      // Every other tag keeps its row but loses any APPROVED mark (it is no longer approved).
      await tx.hashtagSuggestion.updateMany({
        where: { captionSuggestionId: id, status: 'APPROVED' },
        data: { status: 'GENERATED' },
      });

      await tx.captionReview.create({
        data: { suggestionId: id, reviewerId: user.id, decision: 'NEEDS_REVIEW', editedText: text, feedback: dto.feedback ?? null },
      });
    });

    await this.audit.log(user.id, wasApproved ? 'caption.approval.invalidated' : 'caption.edit', 'CaptionSuggestion', id, {
      revision: dto.revision + 1,
    });
    return this.get(id);
  }

  // ================================================================ approve

  async approve(id: string, dto: ApproveSuggestionDto, user: AuthUser) {
    this.requireApprover(user);
    const s = await this.load(id);
    await this.policy.assertHttp({ feature: AI_FEATURE.CAPTIONS, campaignId: this.campaignOf(s), platform: s.platform, action: 'APPROVE' });

    if (s.revision !== dto.revision) {
      throw new ConflictException('Cette suggestion a été modifiée depuis votre lecture. Relisez la version actuelle.');
    }
    if (s.status === 'APPROVED' && s.approvedRevision === s.revision) return present(s); // idempotent
    if (!REVIEWABLE.includes(s.status)) throw new ConflictException(`Impossible d’approuver une suggestion « ${s.status} ».`);

    const text = (s.editedText ?? s.text).trim();
    const lim = PLATFORM_LIMITS[s.platform];
    const active = s.hashtagSuggestions.filter((h) => h.status !== 'REJECTED');

    // Blocking problems: these can never be acknowledged away.
    const blocking: string[] = [];
    if (!text) blocking.push('Le texte est vide.');
    if (text.length > lim.caption) blocking.push(`La légende dépasse ${lim.caption} caractères pour ${s.platform}.`);
    if (active.length > lim.hashtags) blocking.push(`Trop de hashtags pour ${s.platform} (maximum ${lim.hashtags}).`);
    if (active.some((h) => h.hashtag.blocked)) blocking.push('Un hashtag bloqué est présent : retirez-le.');
    if (blocking.length) throw new BadRequestException(blocking);

    // Warnings are recomputed from the text being approved, and must be acknowledged by the reviewer.
    const meta = metaOf(s);
    const warnings = [
      ...new Set([
        ...lintCaption(text, s.language),
        ...checkFacts(text, (meta.allowedFacts as string | undefined) ?? ''),
      ]),
    ];
    const hardLanguage = warnings.filter(
      (w) =>
        w.startsWith('Contient peut-être de l\u2019anglais') ||
        w.startsWith('Arabe littéraire'),
    );
    if (hardLanguage.length) throw new BadRequestException(hardLanguage);
    if (warnings.length && !dto.acknowledgeWarnings) {
      throw new ConflictException({
        code: 'WARNINGS_NOT_ACKNOWLEDGED',
        message: 'Des avertissements doivent être confirmés avant l’approbation.',
        warnings,
      });
    }

    const approvedHashtags = active.map((h) => h.hashtag.displayTag);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.captionSuggestion.updateMany({
        where: { id, revision: dto.revision, status: { in: REVIEWABLE } },
        data: {
          status: 'APPROVED',
          finalText: text,
          approvedById: user.id,
          approvedAt: now,
          approvedRevision: dto.revision,
          warnings,
          metadata: { ...meta, approvedHashtags } as Prisma.InputJsonValue,
        },
      });
      if (res.count === 0) throw new ConflictException('Cette suggestion a changé pendant l’approbation. Relisez-la.');
      await tx.hashtagSuggestion.updateMany({
        where: { captionSuggestionId: id, status: { not: 'REJECTED' } },
        data: { status: 'APPROVED' },
      });
      await tx.captionReview.create({
        data: {
          suggestionId: id,
          reviewerId: user.id,
          decision: 'APPROVED',
          editedText: s.editedText ?? null,
          feedback: dto.feedback ?? null,
        },
      });
    });
    await this.audit.log(user.id, 'caption.approve', 'CaptionSuggestion', id, { revision: dto.revision, warnings: warnings.length });
    return this.get(id);
  }

  // ================================================================ reject

  async reject(id: string, dto: RejectSuggestionDto, user: AuthUser) {
    const s = await this.load(id);
    await this.policy.assertHttp({ feature: AI_FEATURE.CAPTIONS, campaignId: this.campaignOf(s), platform: s.platform, action: 'REJECT' });
    if (!EDITABLE.includes(s.status)) throw new ConflictException(`Impossible de rejeter une suggestion « ${s.status} ».`);

    const { approvedHashtags: _dropped, ...meta } = metaOf(s);
    await this.prisma.$transaction(async (tx) => {
      await tx.captionSuggestion.update({
        where: { id },
        data: {
          status: 'REJECTED',
          finalText: null,
          approvedById: null,
          approvedAt: null,
          approvedRevision: null,
          metadata: meta as Prisma.InputJsonValue,
        },
      });
      // A rejected caption is not automatically a rejected hashtag: only if the reviewer says so.
      await tx.hashtagSuggestion.updateMany({
        where: { captionSuggestionId: id, status: { not: 'REJECTED' } },
        data: { status: dto.rejectHashtags ? 'REJECTED' : 'GENERATED' },
      });
      await tx.captionReview.create({
        data: { suggestionId: id, reviewerId: user.id, decision: 'REJECTED', feedback: dto.feedback ?? null },
      });
      if (dto.rating) {
        await tx.generationFeedback.create({
          data: { suggestionId: id, userId: user.id, rating: dto.rating, reason: dto.feedback ?? null },
        });
      }
    });
    await this.audit.log(user.id, 'caption.reject', 'CaptionSuggestion', id, { feedback: dto.feedback });
    return this.get(id);
  }

  async feedback(id: string, dto: FeedbackDto, user: AuthUser) {
    await this.load(id);
    await this.prisma.generationFeedback.create({
      data: { suggestionId: id, userId: user.id, rating: dto.rating, reason: dto.reason ?? null },
    });
    return this.get(id);
  }

  // ================================================================ apply (never publishes)

  /**
   * Copies the APPROVED text (never the generated one) into a post or the content item.
   * It changes drafts only: the target goes back to DRAFT and needs its normal approval, and this method
   * never calls any publishing endpoint.
   */
  async apply(id: string, dto: ApplySuggestionDto, user: AuthUser) {
    const s = await this.load(id);
    await this.policy.assertHttp({ feature: AI_FEATURE.CAPTIONS, campaignId: this.campaignOf(s), platform: s.platform, action: 'APPLY' });
    if (s.revision !== dto.revision) throw new ConflictException('Cette suggestion a changé. Relisez-la.');
    if (s.status !== 'APPROVED' || s.approvedRevision !== s.revision || !s.finalText) {
      throw new ConflictException('Seule une suggestion approuvée, non modifiée depuis, peut être appliquée.');
    }
    const text = s.finalText;
    const tags = ((metaOf(s).approvedHashtags as string[] | undefined) ?? []).map(displayTag);
    const planCaptionExact = metaOf(s).planCaptionExact === true;

    if (dto.target === 'POST') {
      const post = dto.postId
        ? await this.prisma.post.findUnique({ where: { id: dto.postId } })
        : s.contentItemId
          ? await this.prisma.post.findFirst({
              where: { contentItemId: s.contentItemId, platform: s.platform, status: { not: 'CANCELLED' } },
              orderBy: { createdAt: 'desc' },
            })
          : null;
      if (!post) throw new NotFoundException(`Aucun post ${s.platform} à mettre à jour : générez d’abord les posts du contenu.`);
      if (post.platform !== s.platform) throw new BadRequestException(`Cette suggestion est pour ${s.platform}, pas ${post.platform}.`);
      if (s.contentItemId && post.contentItemId && post.contentItemId !== s.contentItemId) {
        throw new BadRequestException('Ce post appartient à un autre contenu.');
      }
      if (post.caption.trim() && flat(post.caption) !== flat(text) && !dto.confirmOverwrite) {
        throw new ConflictException({
          code: 'OVERWRITE_REQUIRED',
          message: 'Le post contient déjà une légende différente. Confirmez pour la remplacer.',
          current: post.caption,
        });
      }
      // PostsService.update resets approval and dequeues; the link is set AFTER it (update clears links).
      await this.posts.update(post.id, { caption: text, hashtags: tags, captionLanguage: s.language }, user);
      await this.prisma.post.update({ where: { id: post.id }, data: { aiCaptionSuggestionId: s.id } });
      await this.prisma.captionSuggestion.update({ where: { id }, data: { appliedAt: new Date() } });
      await this.audit.log(user.id, 'caption.apply', 'CaptionSuggestion', id, { target: 'POST', postId: post.id });
      return { target: 'POST', post: await this.posts.get(post.id) };
    }

    const itemId = s.contentItemId;
    if (!itemId) throw new BadRequestException('Cette suggestion n’est liée à aucun contenu.');
    const item = await this.content.get(itemId);
    const differs = item.baseCaption.trim() && flat(item.baseCaption) !== flat(text);
    if ((differs || planCaptionExact) && flat(item.baseCaption) !== flat(text) && !dto.confirmOverwrite) {
      throw new ConflictException({
        code: 'OVERWRITE_REQUIRED',
        message: planCaptionExact
          ? 'La légende exacte du planning serait remplacée. Confirmez pour continuer.'
          : 'Le contenu contient déjà une légende différente. Confirmez pour la remplacer.',
        current: item.baseCaption,
      });
    }
    // ContentService.update resets the approval of the item and of every linked post.
    const updated = await this.content.update(itemId, { baseCaption: text, hashtags: tags, captionLanguage: s.language }, user);
    await this.prisma.captionSuggestion.update({ where: { id }, data: { appliedAt: new Date() } });
    await this.audit.log(user.id, 'caption.apply', 'CaptionSuggestion', id, { target: 'CONTENT', contentItemId: itemId });
    return { target: 'CONTENT', content: updated };
  }
}