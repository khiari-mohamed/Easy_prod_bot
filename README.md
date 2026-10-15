# What Else — Campaign Control

Campaign management platform for the *What Else* release (Easy Distribution): content calendar,
AI caption drafts, approval workflow, scheduled publishing to Facebook and Instagram, analytics
and best-time-to-post suggestions. TikTok is handled as a guided manual task.

Stack: Next.js 14 (dashboard) · NestJS 10 (API) · PostgreSQL + Prisma 5 · Redis + BullMQ.

## Run it locally

```bash
npm install
cp apps/api/.env.example apps/api/.env      # then fill it in (see below)
cp apps/web/.env.example apps/web/.env.local
npm run infra:up                             # Postgres + Redis
cd apps/api && npx prisma generate && npx prisma migrate dev --name init && cd ../..
npm run dev:api                              # http://localhost:4000
npm run dev:web                              # http://localhost:3000
```

Values to set in `apps/api/.env`:

| Variable | How |
|---|---|
| `JWT_SECRET` | `openssl rand -hex 32` |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -hex 32` (exactly 64 hex chars). Encrypts social tokens in the DB. Losing it means reconnecting the accounts |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin, created on first boot (password 12+ chars) |
| `PUBLIC_BASE_URL` | Public **HTTPS** URL of the API in production. Meta downloads media from it |
| `ANTHROPIC_API_KEY` | Optional. Without it, captions are placeholder templates |

On first boot the API creates the admin and loads the 3–14 October plan from the PDF.

## How a post flows

`DRAFT → PENDING_APPROVAL → APPROVED (scheduled) → QUEUED → PUBLISHING → PUBLISHED`

- Editors create and submit. Approvers (or admin) approve, publish now, unschedule, cancel.
- Editing a post resets it to draft, so approval always matches what is published.
- A submit is blocked if the caption still contains a `[PLACEHOLDER]`, the media doesn't match the format, or Instagram limits are exceeded.
- The scheduler runs every minute. A slot missed by more than 30 minutes is **never** published late automatically: it becomes "À publier à la main".
- **Pause d'urgence** (red button, top right) stops all automatic publishing instantly.
- TikTok posts, unsupported formats and posts without a connected account become "À publier à la main" at their time, with copy-caption and download-media buttons.
- Interrupted posts are marked FAILED, never auto-retried (the platform may already have published them).
- Every sensitive action is written to `AuditLog`.

## Connecting Facebook and Instagram

1. The Page admin gives you access in Meta Business Suite, and the Instagram account must be Business/Creator and linked to the Page.
2. Create a Meta app (development mode is enough while the Page admin has a role on the app).
3. Generate a user token with: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`.
4. Dashboard → Comptes → paste the token. Set `META_APP_ID`/`META_APP_SECRET` first to get non-expiring Page tokens.

## History for best-time analysis

Analytics → "Importer l'historique": paste a CSV of the Oct 3–9 posts (template provided). Best-time
suggestions stay marked **provisional (generic, not from your data)** until there are 8 posts with metrics per platform.

## Tests

```bash
npm test      # best-time ranking, encryption, post validation rules
```

## What has NOT been verified yet

Be honest with the client about these on day one:

1. **The API has never run against a live Postgres/Redis.** The build sandbox could not download Prisma's engine, so `prisma generate` and a first boot were not exercised. Code type-checks (against stand-in Prisma types) and unit tests pass, but expect to fix small issues on first run.
2. **Meta calls are untested against real Meta.** Endpoints and metric names (especially Facebook insights and Instagram `views`) follow the Graph API as I know it; Meta renames metrics often. `META_GRAPH_VERSION` defaults to `v21.0`: bump it to a currently supported version. Failed metric reads are tolerated and stored as 0.
3. **AI captions** were not run against the live model. Tunisian dialect output must be reviewed by a native speaker before publishing.
4. **The dashboard compiles and builds but was not click-tested in a browser.**
5. **Dockerfiles are untested.**
6. Seeded facts are placeholders: Arabic title (`فانا محط باش تتحط`) was read from the poster/file name and the hashtag `#WhatElse` is a guess. Confirm both, and fill the campaign brief (venue, time, cinemas, handles) via `PATCH /campaign`.

## Known limits

- Facebook REEL posts go out as normal Page videos; Facebook Stories are manual.
- TikTok auto-publishing needs a TikTok app audit; TikTok metrics are entered or imported by hand.
- No ad management: ad spend and sponsorship tracking are out of scope for this version.
- Uploaded media is served publicly at `/media/<uuid>.<ext>` (unguessable names), because Meta must fetch it.
- The scheduler and queue worker run inside the API process. Running several API instances is safe (database-level claims), but give them one shared uploads volume.
