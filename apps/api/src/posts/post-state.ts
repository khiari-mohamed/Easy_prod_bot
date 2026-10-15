import { ApprovalStatus, Platform, Prisma, PostStatus, PublishState } from '@prisma/client';

export const STATE_SYNC: Record<PostStatus, { approvalStatus?: ApprovalStatus; publishState?: PublishState }> = {
  DRAFT: { approvalStatus: 'DRAFT', publishState: 'NOT_SCHEDULED' },
  PENDING_APPROVAL: { approvalStatus: 'PENDING', publishState: 'NOT_SCHEDULED' },
  APPROVED: { approvalStatus: 'APPROVED', publishState: 'SCHEDULED' },
  QUEUED: { approvalStatus: 'APPROVED', publishState: 'QUEUED' },
  PUBLISHING: { approvalStatus: 'APPROVED', publishState: 'PUBLISHING' },
  PUBLISHED: { approvalStatus: 'APPROVED', publishState: 'PUBLISHED' },
  FAILED: { approvalStatus: 'APPROVED', publishState: 'FAILED' },
  MANUAL_REQUIRED: { approvalStatus: 'APPROVED', publishState: 'MANUAL_PENDING' },
  NEEDS_RECONCILIATION: { approvalStatus: 'APPROVED', publishState: 'NEEDS_RECONCILIATION' },
  CANCELLED: { publishState: 'CANCELLED' },
};

export const CLEAR_PUBLISH_AUTH = {
  publishNowAuthorizedAt: null,
  publishNowAuthorizedById: null,
} as const;

export function withState(
  status: PostStatus,
  extra: Prisma.PostUncheckedUpdateManyInput = {},
): Prisma.PostUncheckedUpdateManyInput {
  const keepsAuth = status === 'QUEUED' || status === 'PUBLISHING';
  return {
    ...STATE_SYNC[status],
    ...(keepsAuth ? {} : CLEAR_PUBLISH_AUTH),
    status,
    ...extra,
  };
}

export const PLANNABLE_PLATFORMS: Platform[] = ['FACEBOOK', 'INSTAGRAM', 'TIKTOK'];
