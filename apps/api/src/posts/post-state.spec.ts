import { STATE_SYNC, withState } from './post-state';
import { supportsAutoPublish } from './post.rules';

describe('withState', () => {
  it('keeps status, approvalStatus and publishState aligned', () => {
    expect(withState('MANUAL_REQUIRED')).toMatchObject({
      status: 'MANUAL_REQUIRED',
      approvalStatus: 'APPROVED',
      publishState: 'MANUAL_PENDING',
    });
    expect(withState('DRAFT')).toMatchObject({ approvalStatus: 'DRAFT', publishState: 'NOT_SCHEDULED' });
  });

  it('lets explicit values win (manual confirmation)', () => {
    expect(withState('PUBLISHED', { publishState: 'MANUAL_CONFIRMED' })).toMatchObject({
      status: 'PUBLISHED',
      publishState: 'MANUAL_CONFIRMED',
    });
  });

  it('clears the one-time publish authorization except while queued/publishing', () => {
    expect(withState('QUEUED')).not.toHaveProperty('publishNowAuthorizedAt');
    expect(withState('PUBLISHING')).not.toHaveProperty('publishNowAuthorizedAt');
    expect(withState('FAILED')).toMatchObject({ publishNowAuthorizedAt: null, publishNowAuthorizedById: null });
  });

  it('covers every status', () => {
    expect(Object.keys(STATE_SYNC)).toHaveLength(10);
  });
});

describe('supportsAutoPublish', () => {
  it('never allows TikTok', () => {
    expect(supportsAutoPublish('TIKTOK', 'REEL')).toBe(false);
    expect(supportsAutoPublish('INSTAGRAM', 'REEL')).toBe(true);
  });
});
