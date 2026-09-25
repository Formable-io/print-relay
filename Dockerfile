# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm typecheck && pnpm test && pnpm build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ARG RELAY_VERSION=dev
ENV RELAY_VERSION=$RELAY_VERSION
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
CMD ["node", "dist/index.js"]
