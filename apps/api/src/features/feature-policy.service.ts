import { ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FeatureMode, Prisma, SettingScope } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { SettingsService } from '../settings/settings.module';
import { backgroundSyncEnabled, commentAutomationEnabled } from '../meta/meta-guard';
import { FEATURES, FeatureDef, getFeature } from './feature-registry';
import {
  ConfigRow,
  decide,
  Decision,
  Effective,
  globalMode,
  PolicyContext,
  PolicySnapshot,
  resolveEffective,
} from './policy-resolver';
import { ChangeRequest, validateChange } from './policy-validation';

const CACHE_TTL_MS = 3_000;
const LEGACY_SEEDED_KEY = 'features.legacySeeded';
const COMMENTS_CONFIG_KEY = 'comments.config';

export interface EvaluateInput extends PolicyContext {
  feature: string;
  /** Minimum mode required (default REVIEW = the feature is on in any form). AUTO for unattended actions. */
  need?: FeatureMode;
  /** Free text recorded in logs only ("EXECUTE", "GENERATE"...). */
  action?: string;
  /** Skip the cache. Workers use it right before an external call. */
  fresh?: boolean;
}

export class FeatureDisabledError extends Error {
  constructor(public readonly decision: Decision) {
    super(decision.reason);
  }
}

export class PolicyChangeError extends Error {}

/**
 * The one place that answers "is this allowed right now?".
 * Controllers, schedulers, workers and AI services all call evaluate()/assert().
 * If the policy state cannot be read, every call is DENIED (fail closed).
 */
@Injectable()
export class FeaturePolicyService implements OnModuleInit {
  private readonly log = new Logger(FeaturePolicyService.name);
  private cache: { at: number; snap: PolicySnapshot } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    try {
      await this.seedLegacy();
    } catch (e) {
      this.log.warn(`Legacy settings could not be migrated: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- snapshot

  invalidate() {
    this.cache = null;
  }

  private async load(): Promise<PolicySnapshot> {
    const [rows, campaigns, pause, emergency] = await Promise.all([
      this.prisma.featureConfig.findMany(),
      this.prisma.campaign.findMany({ select: { id: true, autoPublishEnabled: true, publishingPaused: true } }),
      this.settings.pauseState(),
      this.settings.emergencyState(),
    ]);
    return {
      emergencyActive: emergency.active,
      publishingPaused: pause.paused,
      rows: rows.map((r) => ({
        featureKey: r.featureKey,
        scope: r.scope,
        scopeId: r.scopeId,
        mode: r.mode,
        updatedAt: r.updatedAt,
        updatedById: r.updatedById,
      })),
      campaigns: Object.fromEntries(
        campaigns.map((c) => [c.id, { autoPublishEnabled: c.autoPublishEnabled, publishingPaused: c.publishingPaused }]),
      ),
      env: { COMMENT_AUTOMATION: commentAutomationEnabled(), BACKGROUND_SYNC: backgroundSyncEnabled() },
    };
  }

  async snapshot(fresh = false): Promise<PolicySnapshot> {
    const now = Date.now();
    if (!fresh && this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.snap;
    const snap = await this.load();
    this.cache = { at: now, snap };
    return snap;
  }

  // ---------------------------------------------------------------- decisions

  async evaluate(input: EvaluateInput): Promise<Decision> {
    try {
      const snap = await this.snapshot(input.fresh);
      return decide(input.feature, snap, input, input.need ?? 'REVIEW');
    } catch (e) {
      this.log.error(`Policy unavailable (${input.feature}): ${(e as Error).message}`);
      return {
        allowed: false,
        mode: 'OFF',
        code: 'POLICY_UNAVAILABLE',
        reason: 'Les règles d’administration ne sont pas lisibles : action bloquée par sécurité.',
        restrictions: [],
      };
    }
  }

  /** Throws FeatureDisabledError when not allowed. For services, schedulers and workers. */
  async assert(input: EvaluateInput): Promise<Decision> {
    const d = await this.evaluate(input);
    if (!d.allowed) throw new FeatureDisabledError(d);
    return d;
  }

  /** Convenience for controllers: same as assert but throws a Nest ForbiddenException (HTTP 403). */
  async assertHttp(input: EvaluateInput): Promise<Decision> {
    const d = await this.evaluate(input);
    if (!d.allowed) throw new ForbiddenException(d.reason);
    return d;
  }

  /** Effective view of every feature for one context (used by the admin UI and by the web app). */
  async effectiveAll(ctx: PolicyContext = {}): Promise<Effective[]> {
    const snap = await this.snapshot(true);
    return FEATURES.map((f) => resolveEffective(f, snap, ctx));
  }

  // ---------------------------------------------------------------- administration

  async overview() {
    const snap = await this.snapshot(true);
    const [users, audits] = await Promise.all([
      this.prisma.user.findMany({ select: { id: true, name: true } }),
      this.prisma.featureConfigAudit.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { featureKey: true, scope: true, scopeId: true, changedById: true, createdAt: true },
      }),
    ]);
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const lastAudit = new Map<string, { by: string | null; at: Date }>();
    for (const a of audits) {
      const k = `${a.featureKey}|${a.scope}|${a.scopeId}`;
      if (!lastAudit.has(k)) lastAudit.set(k, { by: nameOf.get(a.changedById) ?? null, at: a.createdAt });
    }

    const features = FEATURES.map((def) => {
      const eff = resolveEffective(def, snap, {});
      const overrides = snap.rows
        .filter((r) => r.featureKey === def.key && r.scope !== 'GLOBAL')
        .map((r) => ({
          scope: r.scope,
          scopeId: r.scopeId,
          mode: r.mode,
          updatedAt: r.updatedAt ?? null,
          updatedBy: (r.updatedById && nameOf.get(r.updatedById)) || null,
        }));
      const g = lastAudit.get(`${def.key}|GLOBAL|`);
      return {
        key: def.key,
        group: def.group,
        label: def.label,
        description: def.description,
        kind: def.kind,
        modes: def.modes,
        locked: !!def.locked,
        scopes: def.scopes,
        requires: def.requires ?? [],
        globalMode: eff.globalMode,
        effectiveMode: eff.mode,
        restrictions: eff.restrictions,
        lastChangedBy: g?.by ?? null,
        lastChangedAt: g?.at ?? null,
        overrides,
      };
    });

    return {
      emergency: await this.settings.emergencyState(),
      publishingPaused: snap.publishingPaused,
      features,
    };
  }

  async setMode(req: ChangeRequest, userId: string, reason?: string) {
    const rows = (await this.snapshot(true)).rows;
    const error = validateChange(rows, req);
    if (error) throw new PolicyChangeError(error);

    if (req.scope === 'CAMPAIGN') {
      const c = await this.prisma.campaign.findUnique({ where: { id: req.scopeId }, select: { id: true } });
      if (!c) throw new PolicyChangeError('Campagne introuvable.');
    }
    if (req.scope === 'ACCOUNT') {
      const a = await this.prisma.socialAccount.findUnique({ where: { id: req.scopeId }, select: { id: true } });
      if (!a) throw new PolicyChangeError('Compte social introuvable.');
    }

    const previous = rows.find(
      (r) => r.featureKey === req.featureKey && r.scope === req.scope && r.scopeId === req.scopeId,
    );
    const def = getFeature(req.featureKey) as FeatureDef;
    const previousMode = previous?.mode ?? (req.scope === 'GLOBAL' ? def.default : null);

    await this.prisma.$transaction([
      this.prisma.featureConfig.upsert({
        where: { featureKey_scope_scopeId: { featureKey: req.featureKey, scope: req.scope, scopeId: req.scopeId } },
        create: { featureKey: req.featureKey, scope: req.scope, scopeId: req.scopeId, mode: req.mode, updatedById: userId },
        update: { mode: req.mode, updatedById: userId },
      }),
      this.prisma.featureConfigAudit.create({
        data: {
          featureKey: req.featureKey,
          scope: req.scope,
          scopeId: req.scopeId,
          previous: previousMode ? ({ mode: previousMode } as Prisma.InputJsonValue) : Prisma.JsonNull,
          next: { mode: req.mode } as Prisma.InputJsonValue,
          changedById: userId,
          reason: reason ?? null,
        },
      }),
    ]);
    this.invalidate();
    await this.audit.log(userId, 'feature.update', 'FeatureConfig', req.featureKey, {
      scope: req.scope,
      scopeId: req.scopeId,
      from: previousMode,
      to: req.mode,
      reason,
    });
    await this.applyEffects(req.featureKey);
    return this.overview();
  }

  /** Remove a campaign / platform / account override so it inherits again. Global rows cannot be removed. */
  async clearOverride(featureKey: string, scope: SettingScope, scopeId: string, userId: string, reason?: string) {
    if (scope === 'GLOBAL') throw new PolicyChangeError('Le réglage global ne peut pas être supprimé.');
    const existing = await this.prisma.featureConfig.findUnique({
      where: { featureKey_scope_scopeId: { featureKey, scope, scopeId } },
    });
    if (!existing) return this.overview();
    await this.prisma.$transaction([
      this.prisma.featureConfig.delete({ where: { id: existing.id } }),
      this.prisma.featureConfigAudit.create({
        data: {
          featureKey,
          scope,
          scopeId,
          previous: { mode: existing.mode } as Prisma.InputJsonValue,
          next: { mode: 'INHERIT' } as Prisma.InputJsonValue,
          changedById: userId,
          reason: reason ?? null,
        },
      }),
    ]);
    this.invalidate();
    await this.audit.log(userId, 'feature.override.clear', 'FeatureConfig', featureKey, { scope, scopeId });
    return this.overview();
  }

  history(featureKey: string | undefined, take = 100) {
    return this.prisma.featureConfigAudit.findMany({
      where: featureKey ? { featureKey } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(take, 1), 500),
    });
  }

  // ---------------------------------------------------------------- emergency stop

  async setEmergency(active: boolean, userId: string, reason?: string) {
    const previous = await this.settings.emergencyState();
    const state = await this.settings.setEmergency(active, userId, reason);
    this.invalidate();
    await this.prisma.featureConfigAudit.create({
      data: {
        featureKey: 'automation.emergency_stop',
        scope: 'GLOBAL',
        scopeId: '',
        previous: { active: previous.active } as Prisma.InputJsonValue,
        next: { active } as Prisma.InputJsonValue,
        changedById: userId,
        reason: reason ?? null,
      },
    });
    await this.audit.log(
      userId,
      active ? 'automation.emergency_stop.on' : 'automation.emergency_stop.off',
      'Setting',
      'automation.emergencyStop',
      { reason },
    );
    if (active) await this.cancelPendingAutomation('Arrêt d’urgence');
    return state;
  }

  // ---------------------------------------------------------------- side effects

  /**
   * "Re-enabling a feature must not execute old queued actions."
   * Anything already approved but not yet SENT goes back to a state that needs a fresh decision.
   * Posts need no change: the scheduler already hands a post whose slot was missed by more than
   * 30 minutes to manual publishing.
   */
  private async applyEffects(featureKey: string) {
    try {
      if (featureKey === 'comments.reply') {
        const snap = await this.snapshot(true);
        const mode = globalMode(getFeature(featureKey) as FeatureDef, snap.rows);
        if (mode !== 'AUTO') await this.demoteAutoReplies('Réponses automatiques désactivées');
        if (mode === 'OFF') await this.demoteApprovedReplies('Réponses désactivées');
      }
      if (featureKey === 'comments.first_comment') {
        const snap = await this.snapshot(true);
        if (globalMode(getFeature(featureKey) as FeatureDef, snap.rows) === 'OFF') {
          // "Only posts published after it was switched on": the clock restarts the next time it is enabled.
          const cfgRow = await this.prisma.setting.findUnique({ where: { key: COMMENTS_CONFIG_KEY } });
          if (cfgRow) {
            const value = { ...(cfgRow.value as Record<string, unknown>), firstCommentSince: null } as Prisma.InputJsonValue;
            await this.prisma.setting.update({ where: { key: COMMENTS_CONFIG_KEY }, data: { value } });
          }
          await this.prisma.commentJob.updateMany({
            where: { kind: 'FIRST_COMMENT', status: 'APPROVED' },
            data: { status: 'SKIPPED', note: 'Annulé : premier commentaire désactivé' },
          });
        }
      }
    } catch (e) {
      this.log.warn(`Side effects of ${featureKey} failed: ${(e as Error).message}`);
    }
  }

  private demoteAutoReplies(note: string) {
    return this.prisma.commentJob.updateMany({
      where: { kind: 'REPLY', status: 'APPROVED', auto: true },
      data: { status: 'PENDING_APPROVAL', auto: false, approvedAt: null, approvedById: null, note },
    });
  }

  private demoteApprovedReplies(note: string) {
    return this.prisma.commentJob.updateMany({
      where: { kind: 'REPLY', status: 'APPROVED' },
      data: { status: 'PENDING_APPROVAL', auto: false, approvedAt: null, approvedById: null, note },
    });
  }

  private async cancelPendingAutomation(note: string) {
    await this.demoteApprovedReplies(`${note} : à ré-approuver`);
    await this.prisma.commentJob.updateMany({
      where: { kind: 'FIRST_COMMENT', status: 'APPROVED' },
      data: { status: 'SKIPPED', note: `${note} : annulé` },
    });
  }

  // ---------------------------------------------------------------- legacy migration

  /**
   * One-time, idempotent: copies the old comments switches (Setting "comments.config") into
   * FeatureConfig so there is ONE source of truth. Nothing is overwritten once a row exists.
   */
  async seedLegacy() {
    const done = await this.prisma.setting.findUnique({ where: { key: LEGACY_SEEDED_KEY } });
    if (done) return;
    const row = await this.prisma.setting.findUnique({ where: { key: COMMENTS_CONFIG_KEY } });
    const cfg = (row?.value ?? {}) as Record<string, unknown>;
    const wants: Array<[string, FeatureMode]> = [
      ['comments.first_comment', cfg.firstComment === true ? 'AUTO' : 'OFF'],
      ['comments.reply', cfg.autoReply === true ? 'AUTO' : cfg.aiReply === true ? 'REVIEW' : 'OFF'],
      ['comments.moderation', cfg.moderation === true ? 'AUTO' : 'OFF'],
    ];
    for (const [featureKey, mode] of wants) {
      await this.prisma.featureConfig.upsert({
        where: { featureKey_scope_scopeId: { featureKey, scope: 'GLOBAL', scopeId: '' } },
        create: { featureKey, scope: 'GLOBAL', scopeId: '', mode },
        update: {},
      });
    }
    await this.prisma.setting.upsert({
      where: { key: LEGACY_SEEDED_KEY },
      create: { key: LEGACY_SEEDED_KEY, value: { at: new Date().toISOString() } },
      update: {},
    });
    this.invalidate();
    this.log.log('Legacy comment switches migrated into FeatureConfig');
  }

  /** Used by CommentsService (batch 2) to keep the old boolean config in sync with FeatureConfig. */
  async globalModeOf(featureKey: string): Promise<FeatureMode> {
    const def = getFeature(featureKey);
    if (!def) return 'OFF';
    const snap = await this.snapshot();
    return globalMode(def, snap.rows);
  }

  /** Write a GLOBAL mode without admin-API validation (legacy compatibility paths only). */
  async setGlobalFromLegacy(featureKey: string, mode: FeatureMode, userId?: string) {
    const def = getFeature(featureKey);
    if (!def || !def.modes.includes(mode)) return;
    const before = await this.globalModeOf(featureKey);
    if (before === mode) return; // nothing changed: no write, no audit noise
    await this.prisma.$transaction([
      this.prisma.featureConfig.upsert({
        where: { featureKey_scope_scopeId: { featureKey, scope: 'GLOBAL', scopeId: '' } },
        create: { featureKey, scope: 'GLOBAL', scopeId: '', mode, updatedById: userId ?? null },
        update: { mode, updatedById: userId ?? null },
      }),
      this.prisma.featureConfigAudit.create({
        data: {
          featureKey,
          scope: 'GLOBAL',
          scopeId: '',
          previous: { mode: before } as Prisma.InputJsonValue,
          next: { mode } as Prisma.InputJsonValue,
          changedById: userId ?? 'system',
          reason: 'Modifié depuis la configuration des commentaires',
        },
      }),
    ]);
    this.invalidate();
    await this.applyEffects(featureKey);
  }
}