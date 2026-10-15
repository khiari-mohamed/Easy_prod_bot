FROM node:22-slim AS build
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps/api apps/api
RUN npm run build -w apps/api

FROM node:22-slim
WORKDIR /repo
ENV NODE_ENV=production
# ffmpeg provides ffprobe, which the media pipeline uses to validate videos and Reels.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/apps/api/node_modules apps/api/node_modules
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/prisma apps/api/prisma
COPY --from=build /repo/apps/api/package.json apps/api/package.json
WORKDIR /repo/apps/api
EXPOSE 4000
# Run versioned migrations then start. Generate a migration first:
#   cd apps/api && npx prisma migrate dev --name <description>
# then commit the apps/api/prisma/migrations folder before deploying.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]