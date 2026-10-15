import { capabilitiesFromScopes, expiryFromDebug } from './capabilities';

describe('capabilitiesFromScopes', () => {
  it('Facebook needs pages_manage_posts to publish', () => {
    expect(capabilitiesFromScopes('FACEBOOK', ['pages_show_list', 'pages_read_engagement'])).toEqual({
      canPublish: false,
      canReadInsights: true,
      missing: ['pages_manage_posts'],
    });
    expect(capabilitiesFromScopes('FACEBOOK', ['pages_manage_posts']).canPublish).toBe(true);
  });
  it('Instagram needs content_publish + basic; insights need instagram_manage_insights', () => {
    const c = capabilitiesFromScopes('INSTAGRAM', ['instagram_basic', 'instagram_content_publish']);
    expect(c.canPublish).toBe(true);
    expect(c.canReadInsights).toBe(false);
    expect(c.missing).toEqual(['instagram_manage_insights']);
    expect(capabilitiesFromScopes('INSTAGRAM', ['instagram_content_publish']).canPublish).toBe(false);
  });
  it('a made-up permission (instagram_manage_contents) grants nothing', () => {
    expect(capabilitiesFromScopes('INSTAGRAM', ['instagram_manage_contents']).canReadInsights).toBe(false);
  });
});

describe('expiryFromDebug', () => {
  it('0 or missing = never expires', () => {
    expect(expiryFromDebug(0)).toBeNull();
    expect(expiryFromDebug(undefined)).toBeNull();
  });
  it('a unix time becomes a date', () => {
    expect(expiryFromDebug(1_800_000_000)?.toISOString()).toBe('2027-01-15T08:00:00.000Z');
  });
});
