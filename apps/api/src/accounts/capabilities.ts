/** Pure helpers: what a Meta token can actually do, derived from its granted scopes. No DB, no network. */
export type MetaPlatform = 'FACEBOOK' | 'INSTAGRAM';

export interface Capabilities {
  canPublish: boolean;
  canReadInsights: boolean;
  /** Required permissions that are NOT granted (shown to the admin so they know what to re-grant). */
  missing: string[];
}

const REQUIRED: Record<MetaPlatform, { publish: string[]; insights: string[] }> = {
  FACEBOOK: { publish: ['pages_manage_posts'], insights: ['pages_read_engagement'] },
  INSTAGRAM: { publish: ['instagram_content_publish'], insights: ['instagram_manage_insights'] },
};

export function capabilitiesFromScopes(platform: MetaPlatform, scopes: string[]): Capabilities {
  const have = new Set(scopes.map((s) => s.toLowerCase()));
  const req = REQUIRED[platform];
  const missingPublish = req.publish.filter((s) => !have.has(s));
  const missingInsights = req.insights.filter((s) => !have.has(s));
  // Instagram publishing through a Page token also needs basic access.
  const missingBasic = platform === 'INSTAGRAM' && !have.has('instagram_basic') ? ['instagram_basic'] : [];
  return {
    canPublish: missingPublish.length === 0 && missingBasic.length === 0,
    canReadInsights: missingInsights.length === 0,
    missing: [...missingPublish, ...missingBasic, ...missingInsights],
  };
}

/** Meta's debug_token returns expires_at = 0 for tokens that never expire. */
export function expiryFromDebug(expiresAt: unknown): Date | null {
  return typeof expiresAt === 'number' && expiresAt > 0 ? new Date(expiresAt * 1000) : null;
}
