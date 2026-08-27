#!/bin/sh
# Nightly pg_dump with 14-day local retention + optional R2 upload (S3 API).
# Runs as a long-lived loop container (see docker-compose.prod.yml).
set -eu

apk add --no-cache postgresql16-client rclone curl >/dev/null 2>&1 || true

while true; do
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  FILE="/backups/gogo-${STAMP}.sql.gz"
  echo "[backup] starting ${FILE}"

  if pg_dump -h postgres -U "${POSTGRES_USER}" "${POSTGRES_DB}" | gzip >"${FILE}"; then
    echo "[backup] dump ok ($(du -h "${FILE}" | cut -f1))"

    if [ -n "${R2_ACCOUNT_ID}" ] && [ -n "${R2_ACCESS_KEY_ID}" ]; then
      export RCLONE_CONFIG_R2_TYPE=s3
      export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
      export RCLONE_CONFIG_R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
      export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
      export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
      if rclone copy "${FILE}" "r2:${R2_BACKUP_BUCKET}/pg/"; then
        echo "[backup] uploaded to R2"
        # Remote retention: keep 30 days.
        rclone delete --min-age 30d "r2:${R2_BACKUP_BUCKET}/pg/" || true
      else
        echo "[backup] R2 upload FAILED" >&2
      fi
    else
      echo "[backup] R2 creds not set — local copy only (set R2_* to enable offsite)"
    fi

    # Local retention: 14 days.
    find /backups -name 'gogo-*.sql.gz' -mtime +14 -delete || true

    # Dead-man switch: ping only on success so a stuck backup alerts.
    if [ -n "${HEARTBEAT_URL_BACKUP}" ]; then
      curl -fsS -m 10 "${HEARTBEAT_URL_BACKUP}" >/dev/null || true
    fi
  else
    echo "[backup] pg_dump FAILED" >&2
  fi

  sleep 86400
done
