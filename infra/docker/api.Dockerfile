# syntax=docker/dockerfile:1.7
# Builds the Zvault API image. Build context is the repository root (see src/stacks/api-stack.ts).
# Pin these base images by digest before the first production deploy.

FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@zvault/api..." \
 && pnpm --filter "@zvault/api..." run build \
 && pnpm --filter @zvault/api deploy --legacy --prod /out

# Distroless: no shell, no package manager, runs as uid 65532.
FROM gcr.io/distroless/nodejs22-debian12:nonroot
# Node doesn't trust the Amazon RDS certificate authorities by default; the API verifies the
# database's TLS certificate against this bundle.
ADD --chown=65532:65532 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds/global-bundle.pem
ENV NODE_ENV=production NODE_EXTRA_CA_CERTS=/etc/ssl/rds/global-bundle.pem
WORKDIR /app
COPY --from=build --chown=65532:65532 /out /app
USER 65532
EXPOSE 3000
CMD ["dist/main.js"]
