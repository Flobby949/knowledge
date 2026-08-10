ARG NODE_VERSION=24.18.1

FROM node:${NODE_VERSION}-bookworm-slim AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.20.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build

COPY tsconfig.json tsconfig.build.json vite.config.ts index.html ./
COPY src ./src
COPY scripts ./scripts

RUN pnpm exec tsc -p tsconfig.build.json
RUN pnpm exec vite build --outDir dist/client
RUN pnpm prune --prod

FROM node:${NODE_VERSION}-bookworm-slim AS api

ENV NODE_ENV=production
ENV SERVER_HOST=0.0.0.0
ENV SERVER_PORT=3001

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/dist/scripts ./dist/scripts
COPY migrations ./dist/migrations

USER node

EXPOSE 3001

CMD ["sh", "-c", "node dist/scripts/migrate.js && exec node dist/src/server.js"]

FROM nginx:1.28-alpine AS web

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/client /usr/share/nginx/html

EXPOSE 80
