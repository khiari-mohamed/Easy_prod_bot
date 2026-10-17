import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CommentJob, CommentJobKind, CommentJobStatus, Platform, Post, Prisma, SocialAccount } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { CommentConfig, CONFIG_KEY, DEFAULT_CONFIG, sanitizeConfig } from './comment-config';
import { hasAiKey, lintForAuto, suggestReply } from './comment-ai';
import { SettingsService } from '../settings/settings.module';
import {
  AmbiguousError, CommentPlatform, deleteComment, hideComment, listComments, postComment, RemoteComment, replyToComment,
} from './comment-graph';
import { commentAutomationEnabled, MetaBlockedError, metaGuard } from '../meta/meta-guard';
import { FeaturePolicyService } from '../features/feature-policy.service';

const PLATFORMS: Platform[] = ['FACEBOOK', 'INSTAGRAM'];
// Scopes to verify in the Meta dashboard. Informational only: Graph's own error is the source of truth.
const SCOPES: Record<CommentPlatform, string[]> = {
  INSTAGRAM: ['instagram_manage_comments'],
  FACEBOOK: ['pages_manage_engagement', 'pages_read_user_content'],
};
const MAX_GENERATED_PER_POLL = 10;
type PostWithCampaign = Post & { campaign: { titleLatin: string; titleArabic: string | null; hashtags: string[]; brief: string; releaseDate: Date } | null };

interface PollCtx {
  generated: number;
  autoCount: number;
  summary: { posts: number; comments: number; moderated: number; queued: number; auto: number; skipped: number; errors: string[] };
}

@Injectable()
export class CommentsService {
  private readonly log = new Logger(CommentsService.name);
  private busy = { tick: false, poll: false };
  private warnedNoKey = false;

    constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly settings: SettingsService,
    private readonly policy: FeaturePolicyService,
  ) {}

  // ------------------------------------------------------------ config

  async getConfig(): Promise<CommentConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: CONFIG_KEY } });
    const cfg = sanitizeConfig(row?.value, DEFAULT_CONFIG);
    // Administration Center: the on/off switches live in FeatureConfig (one source of truth). Templates,
    // blocked words and limits stay in this setting.
    const [first, reply, moderation] = await Promise.all([
      this.policy.globalModeOf('comments.first_comment'),
      this.policy.globalModeOf('comments.reply'),
      this.policy.globalModeOf('comments.moderation'),
    ]);
    return {
      ...cfg,
      firstComment: first !== 'OFF',
      aiReply: reply !== 'OFF',
      autoReply: reply === 'AUTO',
      moderation: moderation !== 'OFF',
    };
  }

  async setConfig(patch: Record<string, unknown>, userId?: string) {
    const current = await this.getConfig();
    const next = sanitizeConfig({ ...current, ...patch, firstCommentSince: current.firstCommentSince }, current);
    // "First comment" only concerns posts published after it was switched on.
    if (next.firstComment && !current.firstComment) next.firstCommentSince = new Date().toISOString();
    if (!next.firstComment) next.firstCommentSince = null;
    const value = next as unknown as Prisma.InputJsonValue;
    await this.prisma.setting.upsert({ where: { key: CONFIG_KEY }, create: { key: CONFIG_KEY, value }, update: { value } });
    await this.policy.setGlobalFromLegacy('comments.first_comment', next.firstComment ? 'AUTO' : 'OFF', userId);
    await this.policy.setGlobalFromLegacy('comments.reply', next.autoReply ? 'AUTO' : next.aiReply ? 'REVIEW' : 'OFF', userId);
    await this.policy.setGlobalFromLegacy('comments.moderation', next.moderation ? 'AUTO' : 'OFF', userId);
    await this.audit(userId, 'comments.config.update', 'Setting', CONFIG_KEY, { before: current, after: next });
    return next;
  }

  /** Hook: if your global pause lives somewhere else (a Setting key, say), check it here too. */
    private async paused() {
    if (await this.settings.isPaused()) return true; // the global emergency button
    return (await this.prisma.campaign.count({ where: { publishingPaused: true } })) > 0;
  }

  private audit(userId: string | undefined, action: string, entity: string, entityId: string, data?: unknown) {
    return this.prisma.auditLog
      .create({ data: { userId: userId ?? null, action, entity, entityId, data: (data ?? undefined) as Prisma.InputJsonValue | undefined } })
      .catch((e) => this.log.warn(`audit failed: ${(e as Error).message}`));
  }

  // ------------------------------------------------------------ status

  async status() {
    const [config, paused, counts] = await Promise.all([
      this.getConfig(),
      this.paused(),
      this.prisma.commentJob.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const accounts = [];
    for (const platform of PLATFORMS) {
      const a = await this.accounts.activeFor(platform);
      if (a) accounts.push({ platform, name: a.name, missingScopes: this.missingScopes(a) });
    }
    return {
      config,
      paused,
      aiKey: hasAiKey(),
      accounts,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    };
  }

  private missingScopes(a: SocialAccount): string[] {
    if (!a.grantedScopes?.length) return []; // unknown: do not warn
    return SCOPES[a.platform as CommentPlatform].filter((s) => !a.grantedScopes.includes(s));
  }

  // ------------------------------------------------------------ jobs API

  async listJobs(status?: string, kind?: string, limit = 50) {
    const where: Prisma.CommentJobWhereInput = {};
    if (status && status in CommentJobStatus) where.status = status as CommentJobStatus;
    if (kind && kind in CommentJobKind) where.kind = kind as CommentJobKind;
    return this.prisma.commentJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      include: { post: { select: { caption: true } } },
    });
  }

  private async move(id: string, from: CommentJobStatus[], data: Prisma.CommentJobUpdateManyMutationInput, userId: string | undefined, action: string) {
    const r = await this.prisma.commentJob.updateMany({ where: { id, status: { in: from } }, data });
    if (r.count === 0) {
      const exists = await this.prisma.commentJob.findUnique({ where: { id }, select: { status: true } });
      if (!exists) throw new NotFoundException('Commentaire introuvable');
      throw new ConflictException(`Action impossible : statut actuel ${exists.status}`);
    }
    await this.audit(userId, `comments.job.${action}`, 'CommentJob', id);
    return this.prisma.commentJob.findUnique({ where: { id } });
  }

  async editText(id: string, text: string, userId?: string) {
    const t = (text ?? '').trim();
    if (!t || t.length > 2200) throw new BadRequestException('Texte vide ou trop long');
    return this.move(id, ['PENDING_APPROVAL'], { text: t, aiGenerated: false }, userId, 'edit');
  }

  async approve(id: string, userId?: string) {
    const job = await this.prisma.commentJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Commentaire introuvable');
    if (!job.text.trim()) throw new BadRequestException('Texte vide');
    return this.move(id, ['PENDING_APPROVAL'], { status: 'APPROVED', approvedById: userId ?? null, approvedAt: new Date(), error: null }, userId, 'approve');
  }

  reject(id: string, userId?: string) {
    return this.move(id, ['PENDING_APPROVAL', 'APPROVED', 'FAILED', 'NEEDS_CHECK'], { status: 'REJECTED' }, userId, 'reject');
  }

  retry(id: string, userId?: string) {
    return this.move(id, ['FAILED'], { status: 'APPROVED', error: null }, userId, 'retry');
  }

  /** After a human looked at the platform: it did go out (SENT) or it did not (APPROVED = send again). */
  resolve(id: string, sent: boolean, userId?: string) {
    return this.move(
      id,
      ['NEEDS_CHECK'],
      sent ? { status: 'SENT', sentAt: new Date(), note: 'Confirmé manuellement', error: null } : { status: 'APPROVED', error: null },
      userId,
      sent ? 'resolve.sent' : 'resolve.resend',
    );
  }

  // ------------------------------------------------------------ schedulers

  @Cron('0 * * * * *')
  async tick() {
    if (!commentAutomationEnabled() || metaGuard.isOpen()) return; // META_COMMENT_AUTOMATION=true to enable
    if (this.busy.tick) return;
    this.busy.tick = true;
    try {
      await this.createFirstCommentJobs();
      await this.sendDue();
    } catch (e) {
      this.log.error(`comments tick failed: ${(e as Error).message}`);
    } finally {
      this.busy.tick = false;
    }
  }

  @Cron('0 */15 * * * *')
  async scheduledPoll() {
    if (!commentAutomationEnabled() || metaGuard.isOpen()) return; // META_COMMENT_AUTOMATION=true to enable
    try {
      await this.poll();
    } catch (e) {
      this.log.error(`comments poll failed: ${(e as Error).message}`);
    }
  }

  private async accountFor(post: Pick<Post, 'accountId' | 'platform'>) {
    const a = post.accountId
      ? await this.prisma.socialAccount.findUnique({ where: { id: post.accountId } })
      : await this.accounts.activeFor(post.platform);
    return a && a.status === 'ACTIVE' ? a : null;
  }

  // ------------------------------------------------------------ first comment

  private renderFirstComment(tpl: string, post: Post): string {
    const caption = post.caption.toLowerCase();
    const tags = post.hashtags
      .map((h) => h.trim())
      .filter(Boolean)
      .map((h) => (h.startsWith('#') ? h : `#${h}`))
      .filter((h) => !caption.includes(h.toLowerCase())) // already in the caption: do not repeat
      .slice(0, 30);
    return tpl.replace('{hashtags}', tags.join(' ')).trim().slice(0, 2200);
  }

  private async createFirstCommentJobs() {
    const cfg = await this.getConfig();
    if (!cfg.firstComment) return;
    if (!cfg.firstCommentSince) {
      // Switched on from the Administration Center: start the clock now so old posts never get a comment.
      const row = await this.prisma.setting.findUnique({ where: { key: CONFIG_KEY } });
      const value = { ...sanitizeConfig(row?.value, DEFAULT_CONFIG), firstCommentSince: new Date().toISOString() } as unknown as Prisma.InputJsonValue;
      await this.prisma.setting.upsert({ where: { key: CONFIG_KEY }, create: { key: CONFIG_KEY, value }, update: { value } });
      return;
    }
    const since = new Date(Math.max(Date.parse(cfg.firstCommentSince), Date.now() - 24 * 3600_000));
    const posts = await this.prisma.post.findMany({
      where: {
        status: 'PUBLISHED',
        isExternal: false,
        externalId: { not: null },
        platform: { in: PLATFORMS },
        publishedAt: { gte: since, lte: new Date(Date.now() - 30_000) },
        commentJobs: { none: { kind: 'FIRST_COMMENT' } },
      },
      take: 50,
    });
    for (const post of posts) {
      const allowed = await this.policy.evaluate({
        feature: 'comments.first_comment',
        need: 'AUTO',
        campaignId: post.campaignId,
        platform: post.platform,
        accountId: post.accountId,
      });
      if (!allowed.allowed) continue;
      const account = await this.accountFor(post);
      const text = this.renderFirstComment(cfg.firstCommentTemplate, post);
      await this.prisma.commentJob.create({
        data: {
          platform: post.platform,
          kind: 'FIRST_COMMENT',
          // The post itself was already approved by a human: its hashtags/template are not new content.
          status: !text ? 'SKIPPED' : account ? 'APPROVED' : 'FAILED',
          postId: post.id,
          accountId: account?.id ?? post.accountId,
          remoteMediaId: post.externalId,
          text,
          note: !text ? 'Aucun hashtag à publier' : null,
          error: !text || account ? null : 'Aucun compte actif',
          approvedAt: new Date(),
        },
      });
    }
  }

  // ------------------------------------------------------------ sending

  private async sendDue() {
    const cfg = await this.getConfig();
    if (await this.paused()) return;
    const kinds: CommentJobKind[] = [];
    if (cfg.firstComment) kinds.push('FIRST_COMMENT');
    if (cfg.aiReply || cfg.autoReply) kinds.push('REPLY');
    if (!kinds.length) return;

    // A crash in the middle of a send must never lead to a blind retry.
    await this.prisma.commentJob.updateMany({
      where: { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
      data: { status: 'NEEDS_CHECK', error: "Interrompu pendant l'envoi : vérifiez sur la plateforme" },
    });

    const jobs = await this.prisma.commentJob.findMany({ where: { status: 'APPROVED', kind: { in: kinds } }, orderBy: { createdAt: 'asc' }, take: 3 });
    for (const job of jobs) {
      const claim = await this.prisma.commentJob.updateMany({
        where: { id: job.id, status: 'APPROVED' },
        data: { status: 'SENDING', attempts: { increment: 1 } },
      });
      if (claim.count === 1) await this.send(job);
    }
  }

  /**
   * Last check before the external call, re-read without cache. A job that is no longer allowed goes back
   * to a human decision (reply) or is cancelled (first comment): it is never sent later by surprise.
   */
  private async blockedByAdministration(job: CommentJob): Promise<boolean> {
    const post = job.postId
      ? await this.prisma.post.findUnique({ where: { id: job.postId }, select: { campaignId: true } })
      : null;
    const d = await this.policy.evaluate({
      feature: job.kind === 'FIRST_COMMENT' ? 'comments.first_comment' : 'comments.reply',
      need: job.kind === 'FIRST_COMMENT' || job.auto ? 'AUTO' : 'REVIEW',
      campaignId: post?.campaignId,
      platform: job.platform,
      accountId: job.accountId,
      fresh: true,
      action: 'EXECUTE',
    });
    if (d.allowed) return false;
    const note = `Bloqué par l'administration : ${d.reason}`;
    await this.prisma.commentJob.update({
      where: { id: job.id },
      data:
        job.kind === 'FIRST_COMMENT'
          ? { status: 'SKIPPED', note }
          : { status: 'PENDING_APPROVAL', auto: false, approvedAt: null, approvedById: null, note },
    });
    return true;
  }

  private async send(job: CommentJob) {
    if (await this.blockedByAdministration(job)) return;
    const finish = (data: Prisma.CommentJobUpdateInput) =>
      this.prisma.commentJob.update({ where: { id: job.id }, data }).then(() => this.audit(undefined, `comments.job.${String(data.status).toLowerCase()}`, 'CommentJob', job.id));
    const account = job.accountId ? await this.prisma.socialAccount.findUnique({ where: { id: job.accountId } }) : null;
    if (!account || account.status !== 'ACTIVE') return finish({ status: 'FAILED', error: 'Compte non actif' });
    const platform = job.platform as CommentPlatform;
    const token = this.accounts.token(account);
    try {
      const remoteId =
        job.kind === 'FIRST_COMMENT'
          ? await postComment(platform, job.remoteMediaId as string, job.text, token)
          : await replyToComment(platform, job.remoteCommentId as string, job.text, token);
      await finish({ status: 'SENT', sentAt: new Date(), resultRemoteId: remoteId, error: null });
    } catch (e) {
      if (e instanceof MetaBlockedError) {
        // Refused before anything was sent: not ambiguous. Back to APPROVED, it goes out when Meta calls resume.
        await finish({ status: 'APPROVED', error: e.message });
      } else if (e instanceof AmbiguousError) {
        await finish({ status: 'NEEDS_CHECK', error: `Résultat inconnu : vérifiez sur la plateforme (${e.message})` });
      } else {
        await finish({ status: 'FAILED', error: (e as Error).message });
      }
    }
  }

  // ------------------------------------------------------------ incoming comments

  async poll() {
    const cfg = await this.getConfig();
    const ctx: PollCtx = { generated: 0, autoCount: 0, summary: { posts: 0, comments: 0, moderated: 0, queued: 0, auto: 0, skipped: 0, errors: [] } };
    if (!(cfg.aiReply || cfg.autoReply || cfg.moderation)) return ctx.summary;
    if (metaGuard.isOpen()) {
      ctx.summary.errors.push(`Meta calls are paused: ${metaGuard.status().reason}`);
      return ctx.summary;
    }
    if (await this.paused()) {
      ctx.summary.errors.push('Publishing is paused');
      return ctx.summary;
    }
    if (this.busy.poll) return ctx.summary;
    this.busy.poll = true;
    try {
      ctx.autoCount = await this.prisma.commentJob.count({
        where: { kind: 'REPLY', auto: true, createdAt: { gte: new Date(Date.now() - 3600_000) } },
      });
      const posts = await this.prisma.post.findMany({
        where: {
          status: 'PUBLISHED',
          isExternal: false,
          externalId: { not: null },
          platform: { in: PLATFORMS },
          publishedAt: { gte: new Date(Date.now() - 3 * 24 * 3600_000) },
        },
        include: { campaign: { select: { titleLatin: true, titleArabic: true, hashtags: true, brief: true, releaseDate: true } } },
        orderBy: { publishedAt: 'desc' },
        take: 10,
      });
      for (const post of posts) {
        const account = await this.accountFor(post);
        if (!account) continue;
        ctx.summary.posts++;
        let comments: RemoteComment[];
        try {
          comments = await listComments(post.platform as CommentPlatform, post.externalId as string, this.accounts.token(account), {
            id: account.externalId,
            username: account.username,
          });
        } catch (e) {
          ctx.summary.errors.push(`${post.platform} ${post.externalId}: ${(e as Error).message}`);
          continue;
        }
        for (const c of comments) {
          try {
            await this.handleComment(post, account, cfg, c, ctx);
          } catch (e) {
            ctx.summary.errors.push(`${post.platform} commentaire ${c.id}: ${(e as Error).message}`);
          }
        }
      }
    } finally {
      this.busy.poll = false;
    }
    return ctx.summary;
  }

  private moderationReason(text: string, cfg: CommentConfig): string | null {
    const t = text.toLowerCase();
    const word = cfg.blockedWords.find((w) => t.includes(w));
    if (word) return `Mot interdit : ${word}`;
    if (cfg.hideLinks && /https?:\/\/|www\./i.test(text)) return 'Contient un lien';
    return null;
  }

  private async handleComment(post: PostWithCampaign, account: SocialAccount, cfg: CommentConfig, c: RemoteComment, ctx: PollCtx) {
    if (c.own || c.repliedByUs || c.hidden) return;
    if (Date.now() - c.createdAt.getTime() > cfg.maxCommentAgeHours * 3600_000) return;
    const platform = post.platform as CommentPlatform;
    // Already handled, or one of our own comments (matters when the platform hides the author).
    const seen = await this.prisma.commentJob.findFirst({
      where: { platform: post.platform, OR: [{ remoteCommentId: c.id }, { resultRemoteId: c.id }] },
      select: { id: true },
    });
    if (seen) return;
    ctx.summary.comments++;

    const polCtx = { campaignId: post.campaignId, platform: post.platform, accountId: account.id };
    const moderationOn = (await this.policy.evaluate({ ...polCtx, feature: 'comments.moderation', need: 'AUTO' })).allowed;
    const replyDecision = await this.policy.evaluate({ ...polCtx, feature: 'comments.reply' });

    const base = {
      platform: post.platform,
      postId: post.id,
      accountId: account.id,
      remoteMediaId: post.externalId,
      remoteCommentId: c.id,
      authorName: c.author,
      incomingText: c.text.slice(0, 2000),
    };

    if (cfg.moderation && moderationOn) {
      const reason = this.moderationReason(c.text, cfg);
      if (reason) {
        const token = this.accounts.token(account);
        let error: string | null = null;
        try {
          if (cfg.moderationAction === 'DELETE') await deleteComment(platform, c.id, token);
          else await hideComment(platform, c.id, token);
        } catch (e) {
          error = (e as Error).message;
        }
        await this.create({ ...base, kind: 'MODERATION', status: error ? 'FAILED' : 'SENT', note: `${cfg.moderationAction === 'DELETE' ? 'Supprimé' : 'Masqué'} : ${reason}`, error, sentAt: error ? null : new Date() });
        ctx.summary.moderated++;
        return;
      }
    }

    if (!replyDecision.allowed || !(cfg.aiReply || cfg.autoReply) || !c.text.trim()) return;
    if (!hasAiKey()) {
      if (!this.warnedNoKey) this.log.warn('ANTHROPIC_API_KEY manquante : réponses IA désactivées');
      this.warnedNoKey = true;
      return;
    }
    if (ctx.generated >= MAX_GENERATED_PER_POLL) return; // the rest waits for the next poll
    ctx.generated++;

    let s;
    try {
      s = await suggestReply({ comment: c.text, author: c.author, platform: post.platform, campaign: post.campaign });
    } catch (e) {
      ctx.summary.errors.push(`IA : ${(e as Error).message}`);
      return; // not stored: retried at the next poll
    }
    if ('skip' in s) {
      await this.create({ ...base, kind: 'REPLY', status: 'SKIPPED', note: s.reason });
      ctx.summary.skipped++;
      return;
    }

    const lint = lintForAuto(s.text);
    const underCap = ctx.autoCount < cfg.autoReplyMaxPerHour;
    const auto = cfg.autoReply && replyDecision.mode === 'AUTO' && lint === null && underCap;
    await this.create({
      ...base,
      kind: 'REPLY',
      text: s.text,
      aiGenerated: true,
      auto,
      status: auto ? 'APPROVED' : 'PENDING_APPROVAL',
      approvedAt: auto ? new Date() : null,
      note: auto ? 'Envoi automatique' : cfg.autoReply ? (lint ? `Validation requise : ${lint}` : 'Validation requise : plafond horaire atteint') : null,
    });
    if (auto) { ctx.autoCount++; ctx.summary.auto++; } else ctx.summary.queued++;
  }

  private async create(data: Prisma.CommentJobUncheckedCreateInput) {
    try {
      await this.prisma.commentJob.create({ data });
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e; // unique(platform, remoteCommentId): already handled
    }
  }
}