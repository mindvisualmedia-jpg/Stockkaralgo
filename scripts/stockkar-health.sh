#!/usr/bin/env bash
set -u

AWS_REGION="${AWS_REGION:?AWS_REGION is required}"
APP_NAME="${STOCKKAR_APP_NAME:?STOCKKAR_APP_NAME is required}"
VALUE=0

if curl -fsS --max-time 10 http://127.0.0.1:7777/api/auth/status >/dev/null; then
  VALUE=1
fi

aws cloudwatch put-metric-data \
  --region "$AWS_REGION" \
  --namespace Stockkar/PersonalApp \
  --metric-name BackendHealthy \
  --dimensions "Name=AppName,Value=$APP_NAME" \
  --value "$VALUE" \
  --unit Count
