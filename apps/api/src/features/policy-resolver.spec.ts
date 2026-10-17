import { FeatureMode, SettingScope } from '@prisma/client';
import { FEATURES, getFeature } from './feature-registry';
import { ConfigRow, decide, PolicySnapshot, resolveEffective } from './policy-resolver';
import { validateChange } from './policy-validation';

const row = (
  featureKey: string,
  mode: FeatureMode,
  scope: SettingScope = 'GLOBAL',
  scopeId = '',
): ConfigRow => ({ featureKey, scope, scopeId, mode });

function snap(over: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    emergencyActive: false,
    publishingPaused: false,
    rows: [],
    campaigns: { c1: { autoPublishEnabled: true, publishingPaused: false } },
    env: { COMMENT_AUTOMATION: true, BACKGROUND_SYNC: true },
    ...over,
  };
}

describe('registry', () => {
  it('has unique keys and valid defaults', () => {
    const keys = FEATURES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of FEATURES) expect(f.modes).toContain(f.default);
  });

  it('never lets AI content features run unattended', () => {
    for (const k of ['ai.captions', 'ai.hashtags']) expect(getFeature(k)!.modes).not.toContain('AUTO');
  });

  it('keeps human approval and plan verification locked', () => {
    expect(getFeature('publishing.human_approval')!.locked).toBe('REVIEW');
    expect(getFeature('planning.verification')!.locked).toBe('REVIEW');
  });
});

describe('emergency stop', () => {
  it('forces every external automation OFF, whatever the stored mode', () => {
    const s = snap({ emergencyActive: true, rows: [row('publishing.auto', 'AUTO'), row('comments.reply', 'AUTO')] });
    for (const k of [
      'publishing.auto',
      'publishing.scheduled',
      'publishing.publish_now',
      'comments.reply',
      'comments.first_comment',
      'comments.moderation',
      'analytics.collection',
    ]) {
      const d = decide(k, s, { campaignId: 'c1' });
      expect(d.allowed).toBe(false);
      expect(d.code).toBe('EMERGENCY_STOP');
    }
  });

  it('does not block human-reviewed AI content generation', () => {
    expect(decide('ai.captions', snap({ emergencyActive: true })).allowed).toBe(true);
  });
});

describe('precedence', () => {
  it('a campaign override can restrict but a global OFF cannot be widened by it', () => {
    const s = snap({
      rows: [row('comments.reply', 'OFF'), row('comments.reply', 'AUTO', 'CAMPAIGN', 'c1')],
    });
    expect(decide('comments.reply', s, { campaignId: 'c1' }).allowed).toBe(false);
  });

  it('takes the lowest of global, campaign, platform and account', () => {
    const s = snap({
      rows: [
        row('comments.reply', 'AUTO'),
        row('comments.reply', 'REVIEW', 'PLATFORM', 'INSTAGRAM'),
        row('comments.reply', 'OFF', 'ACCOUNT', 'acc1'),
      ],
    });
    const def = getFeature('comments.reply')!;
    expect(resolveEffective(def, s, { platform: 'FACEBOOK' }).mode).toBe('AUTO');
    expect(resolveEffective(def, s, { platform: 'INSTAGRAM' }).mode).toBe('REVIEW');
    expect(resolveEffective(def, s, { platform: 'INSTAGRAM', accountId: 'acc1' }).mode).toBe('OFF');
  });

  it('REVIEW satisfies a generation need but not an unattended send', () => {
    const s = snap({ rows: [row('comments.reply', 'REVIEW')] });
    expect(decide('comments.reply', s, {}, 'REVIEW').allowed).toBe(true);
    expect(decide('comments.reply', s, {}, 'AUTO').allowed).toBe(false);
  });

  it('ignores a stored mode that is not valid for the feature', () => {
    const s = snap({ rows: [row('ai.captions', 'AUTO')] });
    expect(resolveEffective(getFeature('ai.captions')!, s).mode).toBe('REVIEW');
  });

  it('the environment switch is a hard ceiling', () => {
    const s = snap({
      rows: [row('comments.reply', 'AUTO')],
      env: { COMMENT_AUTOMATION: false, BACKGROUND_SYNC: true },
    });
    expect(decide('comments.reply', s).code).toBe('ENVIRONMENT');
  });
});

describe('legacy campaign flags stay authoritative for publishing', () => {
  it('blocks auto publishing when the campaign has autoPublishEnabled=false', () => {
    const s = snap({ campaigns: { c1: { autoPublishEnabled: false, publishingPaused: false } } });
    expect(decide('publishing.auto', s, { campaignId: 'c1' }).allowed).toBe(false);
    expect(decide('publishing.scheduled', s, { campaignId: 'c1' }).allowed).toBe(true);
  });

  it('blocks every publishing feature when the campaign is paused', () => {
    const s = snap({ campaigns: { c1: { autoPublishEnabled: true, publishingPaused: true } } });
    for (const k of ['publishing.auto', 'publishing.scheduled', 'publishing.publish_now']) {
      expect(decide(k, s, { campaignId: 'c1' }).allowed).toBe(false);
    }
  });

  it('the global publishing pause blocks publishing but not AI caption generation', () => {
    const s = snap({ publishingPaused: true });
    expect(decide('publishing.scheduled', s).code).toBe('PUBLISHING_PAUSED');
    expect(decide('ai.captions', s).allowed).toBe(true);
  });
});

describe('dependencies', () => {
  it('learning is off when caption generation is off', () => {
    const s = snap({ rows: [row('ai.captions', 'OFF'), row('ai.learning', 'AUTO')] });
    const d = decide('ai.learning', s);
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('DEPENDENCY');
  });
});

describe('validateChange', () => {
  it('rejects changing a locked safety rule', () => {
    expect(
      validateChange([], { featureKey: 'publishing.human_approval', scope: 'GLOBAL', scopeId: '', mode: 'OFF' }),
    ).toMatch(/sécurité/);
  });

  it('rejects AUTO for AI caption generation', () => {
    expect(validateChange([], { featureKey: 'ai.captions', scope: 'GLOBAL', scopeId: '', mode: 'AUTO' })).toMatch(/invalide/);
  });

  it('rejects a scoped mode above the global one', () => {
    const rows = [row('comments.reply', 'REVIEW')];
    expect(
      validateChange(rows, { featureKey: 'comments.reply', scope: 'CAMPAIGN', scopeId: 'c1', mode: 'AUTO' }),
    ).toMatch(/restreindre/);
  });

  it('rejects a scope the feature does not support', () => {
    expect(validateChange([], { featureKey: 'ai.captions', scope: 'ACCOUNT', scopeId: 'a', mode: 'OFF' })).toMatch(/niveau/);
  });

  it('rejects enabling learning while captions are off, and disabling captions while learning is on', () => {
    const off = [row('ai.captions', 'OFF')];
    expect(validateChange(off, { featureKey: 'ai.learning', scope: 'GLOBAL', scopeId: '', mode: 'AUTO' })).toMatch(/d’abord/);
    const on = [row('ai.captions', 'REVIEW'), row('ai.learning', 'AUTO')];
    expect(validateChange(on, { featureKey: 'ai.captions', scope: 'GLOBAL', scopeId: '', mode: 'OFF' })).toMatch(/Désactivez/);
  });

  it('accepts a valid change', () => {
    expect(validateChange([], { featureKey: 'comments.reply', scope: 'GLOBAL', scopeId: '', mode: 'REVIEW' })).toBeNull();
  });
});