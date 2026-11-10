# catalog-api: build with pnpm in the monorepo, run on distroless Node (non-root).
# Build from the repo root: docker build -f services/catalog-api/Dockerfile .
FROM --platform=$BUILDPLATFORM node:26.13.0-trixie-slim AS build
RUN npm install -g pnpm@12.18.0 >/dev/null
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY services/catalog-api/package.json services/catalog-api/
RUN pnpm install --frozen-lockfile --filter @streamforge/catalog-api
COPY services/catalog-api services/catalog-api
RUN pnpm --filter @streamforge/catalog-api build \
 && pnpm --filter @streamforge/catalog-api deploy --legacy --prod /out \
 && cp -r services/catalog-api/dist services/catalog-api/drizzle /out/

FROM gcr.io/distroless/nodejs26-debian13@sha256:33c86a63859efc2ebd88ea0a355863582ec6f1220d048de62baffb2584e709b3
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/drizzle ./drizzle
ENV NODE_ENV=production API_PORT=4000
USER nonroot
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# distroless entrypoint is node; `dist/seed.js` creates the demo user (Kubernetes Job)
CMD ["dist/main.js"]
