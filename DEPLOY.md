# Deploy on your VPS

Needs: a Linux VPS with Docker + Docker Compose, and a (sub)domain whose DNS A record points at it.
Ports 80 and 443 must be open.

```bash
tar xzf whatelse-campaign.tar.gz && cd whatelse-campaign
cp .env.prod.example .env.prod && nano .env.prod
sed -i 's/\r$//' .env.prod            # remove Windows line endings if the file was edited on Windows
sh scripts/check-env.sh                # fails with a clear message if anything required is missing
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f docker-compose.prod.yml ps               # api must become "healthy" (up to ~60 s)
docker compose -f docker-compose.prod.yml logs -f api      # watch the first boot
```

Never put `.env`, `.env.prod` or any token in a zip or in a chat. `.gitignore` and `.dockerignore`
now exclude them. If a secret was ever shared, rotate it (Meta app secret, JWT secret, passwords).

The API image includes `ffmpeg`/`ffprobe`, which the media pipeline needs to validate videos and Reels.

On first boot the API creates the tables, the admin user and the campaign plan. Open
`https://<your domain>` and log in.

## Connect Facebook + Instagram

1. Put the **Facebook app's** ID and secret in `.env.prod` (`META_APP_ID`, `META_APP_SECRET`), then
   `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d`.
2. In Graph Explorer, generate a user token with ALL of these permissions:
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
   `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`.
   (`pages_manage_posts` is required to post on Facebook. Your last token did not include it.)
3. Dashboard → Comptes → paste the token → Connecter. Then click Vérifier.
4. Upload a small test image and a short vertical MP4 in Médias, create a post for each on the
   Page and Instagram, approve, and "Publier maintenant". Delete the test posts afterwards.

## If something fails

- Instagram "could not process media": use MP4 (H.264 + AAC), vertical 9:16, under ~90 s, and open
  `https://<domain>/media/<file>` in a private window to confirm it is publicly reachable.
- Meta error code 190 or 10: token expired or missing permission. Regenerate with the full list above.
- Check `docker compose ... logs api` and send me the error.

## Backups

```bash
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U campaign WhatElse_db > backup.sql
```

## Migrations

The `apps/api/prisma/migrations/` folder is committed and applied automatically by the Docker image
on every deploy via `prisma migrate deploy`.

On a FRESH database there is nothing to backfill: `prisma migrate deploy` is enough. Run
`scripts/backfill.sql` only when upgrading a database that already holds v1 posts.

### Apply locally (first time or after a schema change)

```bash
# 1. Start Postgres
npm run infra:up

# 2. Apply all pending migrations and regenerate the Prisma client
cd apps/api
npx prisma migrate deploy
npx prisma generate

# 3. Run the data backfill (must run BEFORE starting the new API)
psql "$DATABASE_URL" -f ../../scripts/backfill.sql
# Check the verification output at the bottom — all counts should be 0.
```

### Add a new migration after editing schema.prisma

```bash
cd apps/api
npx prisma migrate dev --name <short_description>
# Commit the new migration file before deploying.
```

### Rollback migration 0001_expand

If you need to revert (drops all new columns/tables — take a backup first):

```bash
# Local
psql "$DATABASE_URL" -f scripts/rollback-0001.sql

# Production container
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U campaign WhatElse_db < scripts/rollback-0001.sql
```

After rollback, redeploy the previous image. The old schema is fully restored.
Note: enum values added to existing types cannot be removed in Postgres without
recreating the type — they are harmless to leave in place.

## Before you trust it

Reset the Meta app secret and re-generate tokens if they were ever pasted anywhere outside this server.
