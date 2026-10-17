/** Single source of truth for the Caption Studio and Administration API paths. */
export const EP = {
  captions: {
    generate: '/captions/generate',
    list: (qs: string) => `/captions/suggestions?${qs}`,
    one: (id: string) => `/captions/${id}`,
    approve: (id: string) => `/captions/${id}/approve`,
    reject: (id: string) => `/captions/${id}/reject`,
    apply: (id: string) => `/captions/${id}/apply`,
    feedback: (id: string) => `/captions/${id}/feedback`,
  },
  hashtags: {
    create: '/hashtags',
    search: (qs: string) => `/hashtags?${qs}`,
    recommendations: (qs: string) => `/hashtags/recommendations?${qs}`,
  },
  trends: (qs: string) => `/trends?${qs}`,
  trendAdd: '/trends',
  trendOne: (id: string) => `/trends/${encodeURIComponent(id)}`,
  features: {
    overview: '/administration/overview',
    effective: '/administration/effective',
    effectiveFor: (qs: string) => `/administration/effective?${qs}`,
    one: (key: string) => `/administration/features/${encodeURIComponent(key)}`,
    clear: (key: string, scope: string, scopeId: string) =>
      `/administration/features/${encodeURIComponent(key)}?scope=${encodeURIComponent(scope)}&scopeId=${encodeURIComponent(scopeId)}`,
    emergency: '/administration/emergency-stop',
    history: (qs: string) => `/administration/history?${qs}`,
  },
} as const;