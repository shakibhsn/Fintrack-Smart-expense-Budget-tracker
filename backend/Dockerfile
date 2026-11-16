# FinTrack API image. Multi-stage: dependencies are installed once, the final image runs as a non-root user and contains no build tooling.
#   docker build -t fintrack-api ./backend
#   docker run --env-file backend/.env.production -p 5000:5000 fintrack-api
# Database migrations are a SEPARATE release step (see docs/deployment/SETUP.md):  docker run --rm --env-file ... fintrack-api npx prisma migrate deploy

FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

FROM node:20-bookworm-slim AS runtime
ARG GIT_SHA=unknown
ENV NODE_ENV=production GIT_SHA=$GIT_SHA
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && groupadd --system app && useradd --system --gid app --home /app app
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./
COPY --chown=app:app prisma ./prisma
COPY --chown=app:app src ./src
COPY --chown=app:app docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
USER app
EXPOSE 5000
# liveness only (is the process answering?). Readiness - database + background jobs - is /api/health/ready and is what a load balancer / App Runner should use.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
