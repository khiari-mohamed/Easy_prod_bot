# NOTE: not built or tested yet (no Docker in the build sandbox). Build from the repo root:
#   docker build -f apps/web/Dockerfile --build-arg API_INTERNAL_URL=http://api:4000 -t whatelse-web .
FROM node:22-slim AS build
WORKDIR /repo
ARG API_INTERNAL_URL=http://localhost:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM node:22-slim
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/apps/web apps/web
WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
