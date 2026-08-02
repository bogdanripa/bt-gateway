#!/usr/bin/env bash
#
# Tear down the GCP resources bt-gateway no longer uses, after the move to the
# Pi. Companion to scripts/migrate-to-postgres.mjs.
#
# ---------------------------------------------------------------------------
# READ THIS FIRST
# ---------------------------------------------------------------------------
#
# DO NOT DELETE THE PROJECT. `auto-trader-493814` still hosts Firebase Auth,
# which the gateway uses to verify every UI sign-in. Deleting the project
# takes Google sign-in down permanently and there is no migration path back.
# This script never touches the project, Firebase Auth, or the Firebase web
# app config.
#
# Order matters, and the phases are gated because the mistakes here are
# unrecoverable:
#
#   - The Cloud Scheduler job is what keeps BT refresh tokens alive. Delete it
#     before the Pi's cron is running and every tenant gets forced back
#     through an SMS OTP.
#   - The VPC connector / NAT / static IP are what give the RUNNING Cloud Run
#     service its pinned egress. Delete them while it still serves traffic and
#     BT starts rejecting refreshes with `IP diferit`.
#   - Firestore holds the only copy of tenant data until the migration has
#     been applied AND verified on the Pi.
#   - The KMS key is the only thing that can decrypt the Firestore
#     ciphertexts. Destroy it and even a Firestore backup becomes worthless.
#     It goes last, on its own, after everything else is proven.
#
# Usage — one phase at a time, checking in between:
#
#   ./scripts/decommission-gcp.sh preflight   # verify the cutover really happened
#   ./scripts/decommission-gcp.sh phase1      # stop serving + stop the cron
#   ./scripts/decommission-gcp.sh phase2      # network: NAT, connector, static IP
#   ./scripts/decommission-gcp.sh phase3      # build/deploy plumbing
#   ./scripts/decommission-gcp.sh phase4      # DESTRUCTIVE: Firestore data
#   ./scripts/decommission-gcp.sh phase5      # DESTRUCTIVE: KMS key versions
#
# Add DRY_RUN=1 to print what each phase would do without doing it.
#
# Phases 4 and 5 additionally require CONFIRM=yes-delete-my-data, because a
# mistyped phase number should not be able to destroy anything.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-auto-trader-493814}"
REGION="${REGION:-europe-west3}"
SERVICE_NAME="${SERVICE_NAME:-bt-gateway}"
NEW_URL="${NEW_URL:-https://bt-gateway-coolify.bogdanripa.com}"

VPC_NAME="bt-gw-vpc"
SUBNET_NAME="bt-gw-subnet"
CONNECTOR_NAME="bt-gw-connector"
ROUTER_NAME="bt-gw-router"
NAT_NAME="bt-gw-nat"
STATIC_IP_NAME="bt-gw-egress-ip"
AR_REPO="${AR_REPO:-bt-gateway}"
RUNTIME_SA="bt-gateway-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_SA="bt-gateway-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
WIF_POOL_NAME="github-actions"
CRON_JOB_NAME="bt-gateway-refresh-cron"
CRON_SECRET_NAME="bt-gateway-cron-secret"
KMS_KEYRING="${KMS_KEYRING:-bt-gateway}"
KMS_KEY="${KMS_KEY:-tenant-creds}"

run() {
  echo "+ $*" >&2
  if [[ "${DRY_RUN:-0}" != "1" ]]; then
    "$@"
  fi
}

# Delete something only if it exists, so re-running a phase is safe.
maybe() {
  local desc="$1"; shift
  local check_cmd="$1"; shift
  if eval "$check_cmd" >/dev/null 2>&1; then
    echo "-- removing $desc"
    run "$@"
  else
    echo "-- $desc already gone, skipping"
  fi
}

require_confirm() {
  if [[ "${CONFIRM:-}" != "yes-delete-my-data" ]]; then
    cat >&2 <<EOF

REFUSING TO RUN. This phase permanently destroys data.

Re-run with:
    CONFIRM=yes-delete-my-data $0 $1

Before you do, be certain that:
  - the Pi has been serving real traffic for long enough to trust it,
  - you have signed in, placed a demo order, and seen your audit history,
  - you have a Firestore export you can actually restore from.

EOF
    exit 1
  fi
}

# ---------------------------------------------------------------------------

cmd_preflight() {
  local failed=0
  echo "== Preflight: is the cutover actually done? =="
  echo

  echo "-- new deployment answers /api/health"
  if curl -fsS --max-time 20 "$NEW_URL/api/health" | tee /dev/stderr | grep -q '"ok":true'; then
    echo "   PASS"
  else
    echo "   FAIL — the Pi is not serving. Do not proceed."; failed=1
  fi
  echo

  echo "-- new deployment reports an egress IP (BT pins tokens to it)"
  local ip
  ip="$(curl -fsS --max-time 20 "$NEW_URL/api/health" | sed -n 's/.*"egressIp":"\([^"]*\)".*/\1/p')"
  if [[ -n "$ip" && "$ip" != "null" ]]; then
    echo "   PASS — egress IP is $ip"
  else
    echo "   WARN — no egress IP reported; check outbound networking on the Pi"
  fi
  echo

  echo "-- Postgres has migrated data"
  cat <<EOF
   MANUAL CHECK. Run against the bt-gateway app's database:

     SELECT
       (SELECT count(*) FROM users)     AS users,
       (SELECT count(*) FROM bt_creds)  AS creds,
       (SELECT count(*) FROM api_keys)  AS api_keys,
       (SELECT count(*) FROM events)    AS events;

   These must be non-zero and must match what Firestore held.
EOF
  echo

  echo "-- credentials actually DECRYPT under the new MASTER_KEY"
  cat <<EOF
   MANUAL CHECK, and the one people skip. Row counts prove the rows copied;
   they do not prove the re-encryption worked. Sign in to $NEW_URL and
   trigger something that reads BT credentials (a session refresh, or any
   /api/v1 call that needs a BT client). If MASTER_KEY is wrong, the rows are
   there and are permanently unreadable — and you will only find out after
   Firestore and KMS are gone.
EOF
  echo

  echo "-- the 45-minute refresh cron is running on the new platform"
  echo "   MANUAL CHECK: confirm the platform cron exists and has fired at"
  echo "   least once (look for cron.refresh.summary in the container logs)."
  echo

  if [[ "$failed" == "1" ]]; then
    echo "PREFLIGHT FAILED — stop here."; exit 1
  fi
  echo "Automated checks passed. Do the manual ones before phase 1."
}

cmd_phase1() {
  echo "== Phase 1: stop serving from Cloud Run, stop the old cron =="
  echo "After this, $NEW_URL is the only thing serving."
  echo

  maybe "Cloud Scheduler job $CRON_JOB_NAME" \
    "gcloud scheduler jobs describe $CRON_JOB_NAME --location=$REGION --project=$PROJECT_ID" \
    gcloud scheduler jobs delete "$CRON_JOB_NAME" \
      --location="$REGION" --project="$PROJECT_ID" --quiet

  maybe "Cloud Run service $SERVICE_NAME" \
    "gcloud run services describe $SERVICE_NAME --region=$REGION --project=$PROJECT_ID" \
    gcloud run services delete "$SERVICE_NAME" \
      --region="$REGION" --project="$PROJECT_ID" --quiet

  echo
  echo "Done. The old custom domain (bt-gateway.bogdanripa.com) now points at"
  echo "nothing — repoint or retire that DNS record."
}

cmd_phase2() {
  echo "== Phase 2: networking (only safe once Cloud Run is gone) =="
  echo

  maybe "Cloud NAT $NAT_NAME" \
    "gcloud compute routers nats describe $NAT_NAME --router=$ROUTER_NAME --region=$REGION --project=$PROJECT_ID" \
    gcloud compute routers nats delete "$NAT_NAME" \
      --router="$ROUTER_NAME" --region="$REGION" --project="$PROJECT_ID" --quiet

  maybe "Cloud Router $ROUTER_NAME" \
    "gcloud compute routers describe $ROUTER_NAME --region=$REGION --project=$PROJECT_ID" \
    gcloud compute routers delete "$ROUTER_NAME" \
      --region="$REGION" --project="$PROJECT_ID" --quiet

  # The connector is usually the single biggest line item here — it runs
  # e2-micro instances around the clock.
  maybe "VPC Access connector $CONNECTOR_NAME" \
    "gcloud compute networks vpc-access connectors describe $CONNECTOR_NAME --region=$REGION --project=$PROJECT_ID" \
    gcloud compute networks vpc-access connectors delete "$CONNECTOR_NAME" \
      --region="$REGION" --project="$PROJECT_ID" --quiet

  # Releasing the reserved address gives up the IP for good. If there is any
  # chance of moving back to Cloud Run, keep it — it is a few dollars a month.
  maybe "reserved static IP $STATIC_IP_NAME" \
    "gcloud compute addresses describe $STATIC_IP_NAME --region=$REGION --project=$PROJECT_ID" \
    gcloud compute addresses delete "$STATIC_IP_NAME" \
      --region="$REGION" --project="$PROJECT_ID" --quiet

  maybe "subnet $SUBNET_NAME" \
    "gcloud compute networks subnets describe $SUBNET_NAME --region=$REGION --project=$PROJECT_ID" \
    gcloud compute networks subnets delete "$SUBNET_NAME" \
      --region="$REGION" --project="$PROJECT_ID" --quiet

  maybe "VPC $VPC_NAME" \
    "gcloud compute networks describe $VPC_NAME --project=$PROJECT_ID" \
    gcloud compute networks delete "$VPC_NAME" --project="$PROJECT_ID" --quiet
}

cmd_phase3() {
  echo "== Phase 3: build + deploy plumbing =="
  echo "None of this is referenced by the new pipeline, which builds on"
  echo "GitHub and pushes to ghcr.io."
  echo

  maybe "Artifact Registry repo $AR_REPO (all images)" \
    "gcloud artifacts repositories describe $AR_REPO --location=$REGION --project=$PROJECT_ID" \
    gcloud artifacts repositories delete "$AR_REPO" \
      --location="$REGION" --project="$PROJECT_ID" --quiet

  maybe "Workload Identity pool $WIF_POOL_NAME" \
    "gcloud iam workload-identity-pools describe $WIF_POOL_NAME --location=global --project=$PROJECT_ID" \
    gcloud iam workload-identity-pools delete "$WIF_POOL_NAME" \
      --location=global --project="$PROJECT_ID" --quiet

  maybe "deployer service account" \
    "gcloud iam service-accounts describe $DEPLOYER_SA --project=$PROJECT_ID" \
    gcloud iam service-accounts delete "$DEPLOYER_SA" --project="$PROJECT_ID" --quiet

  maybe "Secret Manager secret $CRON_SECRET_NAME" \
    "gcloud secrets describe $CRON_SECRET_NAME --project=$PROJECT_ID" \
    gcloud secrets delete "$CRON_SECRET_NAME" --project="$PROJECT_ID" --quiet

  # The runtime SA goes last of the identities: it is what any leftover
  # Firestore/KMS access would run as, so keep it until phases 4 and 5 are
  # done. Deleting it here would lock you out of your own export.
  echo
  echo "NOT deleting the runtime SA ($RUNTIME_SA) yet — it is the identity"
  echo "that can still read Firestore and KMS. Remove it after phase 5:"
  echo "    gcloud iam service-accounts delete $RUNTIME_SA --project=$PROJECT_ID"
}

cmd_phase4() {
  require_confirm phase4
  echo "== Phase 4: Firestore tenant data (DESTRUCTIVE) =="
  echo

  local bucket="gs://${PROJECT_ID}-bt-gateway-final-export"
  cat <<EOF
Take an export first. It is cheap, and it is the only way back if the
Postgres side turns out to be wrong later.

    gsutil mb -l $REGION $bucket
    gcloud firestore export $bucket --project=$PROJECT_ID

Keep that bucket until you are certain. NOTE: the export contains
KMS-encrypted credential blobs, so it is only usable while the KMS key from
phase 5 still exists. An export plus a destroyed key is not a backup.

Then delete the collections:

    gcloud firestore databases delete --database='(default)' --project=$PROJECT_ID

  or, to keep the database and drop only this service's data:

    for c in users key_hashes oauth_clients oauth_codes; do
      gcloud firestore bulk-delete --collection-ids="\$c" --project=$PROJECT_ID
    done

This script does not run either command for you. Deleting a Firestore
database is not something to trigger from an argv match — paste it yourself
once you have read it.
EOF
}

cmd_phase5() {
  require_confirm phase5
  echo "== Phase 5: KMS key versions (DESTRUCTIVE, IRREVERSIBLE) =="
  echo

  cat <<EOF
This is the point of no return. Destroying these key versions makes every
Firestore ciphertext — including anything in the phase 4 export — permanently
undecryptable. Nothing about the Pi depends on this key any more; the only
reason to keep it is to preserve your ability to go back.

Recommendation: DISABLE rather than destroy, and revisit in a month. A
disabled key costs almost nothing and can be re-enabled instantly.

Disable every version:

    for v in \$(gcloud kms keys versions list --key=$KMS_KEY --keyring=$KMS_KEYRING \\
                  --location=$REGION --project=$PROJECT_ID \\
                  --filter='state:ENABLED' --format='value(name)'); do
      gcloud kms keys versions disable "\$v" --key=$KMS_KEY --keyring=$KMS_KEYRING \\
        --location=$REGION --project=$PROJECT_ID
    done

If you are certain, schedule destruction instead (24h+ grace period, and
reversible until it elapses):

    for v in \$(gcloud kms keys versions list --key=$KMS_KEY --keyring=$KMS_KEYRING \\
                  --location=$REGION --project=$PROJECT_ID \\
                  --filter='state:ENABLED' --format='value(name)'); do
      gcloud kms keys versions destroy "\$v" --key=$KMS_KEY --keyring=$KMS_KEYRING \\
        --location=$REGION --project=$PROJECT_ID
    done

Keyrings and keys themselves cannot be deleted in GCP — an empty keyring is
free and simply stays there.
EOF
}

case "${1:-}" in
  preflight) cmd_preflight ;;
  phase1)    cmd_phase1 ;;
  phase2)    cmd_phase2 ;;
  phase3)    cmd_phase3 ;;
  phase4)    cmd_phase4 ;;
  phase5)    cmd_phase5 ;;
  *)
    sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
