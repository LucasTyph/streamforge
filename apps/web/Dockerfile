# web: Next.js standalone output on distroless Node (non-root).
# Build from the repo root: docker build -f apps/web/Dockerfile .
# NEXT_PUBLIC_* are inlined at build time; defaults suit the single-host ingress
# (API at /api, live events at /events on the same origin).
FROM node:26.13.0-trixie-slim AS build
RUN npm install -g pnpm@12.18.0 >/dev/null
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @streamforge/web
COPY apps/web apps/web
ARG NEXT_PUBLIC_API_URL=/api
ARG NEXT_PUBLIC_PROGRESS_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_PROGRESS_URL=$NEXT_PUBLIC_PROGRESS_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @streamforge/web build

FROM gcr.io/distroless/nodejs26-debian13@sha256:33c86a63859efc2ebd88ea0a355863582ec6f1220d048de62baffb2584e709b3
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
USER nonroot
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["apps/web/server.js"]
