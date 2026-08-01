# Build context: monorepo root (docker build -f apps/web/vault/Dockerfile .)

FROM node:25-alpine AS build
WORKDIR /build
RUN npm install -g pnpm@10

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/vault/package.json apps/web/vault/
COPY packages/vault/package.json packages/vault/

RUN pnpm install --frozen-lockfile --filter @barry/vault-server... --filter @barry/vault...

COPY apps/web/vault/ apps/web/vault/
COPY packages/vault/ packages/vault/

RUN cd apps/web/vault && pnpm run build

# ---

FROM node:25-alpine
WORKDIR /app
RUN apk add --no-cache wget

COPY --from=build /build/apps/web/vault/dist/server.mjs ./server.mjs
COPY --from=build /build/apps/web/vault/src/ui/ ./ui/

# Copy the pre-built native module and its runtime dependencies from the build stage
COPY --from=build /build/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/ ./node_modules/better-sqlite3/
COPY --from=build /build/node_modules/.pnpm/better-sqlite3@*/node_modules/bindings/ ./node_modules/bindings/
COPY --from=build /build/node_modules/.pnpm/bindings@*/node_modules/file-uri-to-path/ ./node_modules/file-uri-to-path/

ENV PORT=3923
ENV DATA_DIR=/data
EXPOSE 3923
VOLUME /data

CMD ["node", "server.mjs"]
