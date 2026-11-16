#!/bin/sh
# Optional release step inside the container: with RUN_MIGRATIONS=true the API applies pending Prisma migrations before it starts listening.
# `prisma migrate deploy` only applies migrations that were already reviewed and committed (never generates or resets anything) and takes a
# database advisory lock, so two containers starting together cannot apply the same migration twice. If it fails the container exits and the
# platform keeps serving the previous version. Take a database backup BEFORE a release that contains a migration (docs/deployment/BACKUP_RESTORE.md).
set -e
if [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "[entrypoint] applying database migrations"
  npx prisma migrate deploy
fi
exec "$@"
