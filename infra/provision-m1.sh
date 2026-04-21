#!/usr/bin/env bash
#
# M1 infra provisioning for bt-gateway.
#
# Creates everything needed to stand up a Cloud Run service with a STATIC
# egress IP (via VPC Connector + Cloud NAT + reserved external IP). Without
# this, BT Trade's refresh tokens die between invocations because Cloud Run's
# default egress rotates through a shared pool.
#
# Idempotent — re-running is safe. Each resource is checked first and skipped
# if it already exists. That way you can run this after editing one constant
# and not blow away the existing resources.
#
# Run from a machine with gcloud auth'd as an owner of $PROJECT_ID.
#
#   chmod +x infra/provision-m1.sh
#   ./infra/provision-m1.sh
#
# If you want to see what it would do without changing anything, pass DRY_RUN=1.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-auto-trader-493814}"
REGION="${REGION:-europe-west3}"
SERVICE_NAME="${SERVICE_NAME:-bt-gateway}"

# Networking
VPC_NAME="bt-gw-vpc"
SUBNET_NAME="bt-gw-subnet"
SUBNET_CIDR="10.20.0.0/24"
CONNECTOR_NAME="bt-gw-connector"
# VPC Access connectors need a /28 subnet inside the region's VPC; carve it out
# of the same VPC we created above. Must not overlap SUBNET_CIDR.
CONNECTOR_CIDR="10.20.1.0/28"
ROUTER_NAME="bt-gw-router"
NAT_NAME="bt-gw-nat"
STATIC_IP_NAME="bt-gw-egress-ip"

# Artifacts + runtime
AR_REPO="${AR_REPO:-bt-gateway}"
RUNTIME_SA="bt-gateway-runtime"
DEPLOYER_SA="bt-gateway-deployer"

# CI identity (GitHub Actions) — created empty for now, wired to Workload
# Identity Federation later in this script.
GH_REPO_OWNER="${GH_REPO_OWNER:-bogdanripa}"
GH_REPO_NAME="${GH_REPO_NAME:-bt-gateway}"
WIF_POOL_NAME="github-actions"
WIF_PROVIDER_NAME="github"

run() {
  echo "+ $*" >&2
  if [[ "${DRY_RUN:-0}" != "1" ]]; then
    "$@"
  fi
}

# ---- project + APIs -------------------------------------------------------
run gcloud config set project "$PROJECT_ID"

run gcloud services enable \
  compute.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  vpcaccess.googleapis.com \
  iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com \
  cloudscheduler.googleapis.com \
  firestore.googleapis.com \
  cloudkms.googleapis.com \
  secretmanager.googleapis.com \
  --project="$PROJECT_ID"

# `services enable` returns success before the API is actually usable
# elsewhere (Google's internal propagation takes 60–120 s). Poll until the
# first API we need — Compute — responds, then fall through. Without this,
# the very next `networks create` call can fail with SERVICE_DISABLED.
echo "Waiting for Compute Engine API to become usable (propagation)..."
for attempt in $(seq 1 24); do
  if gcloud compute networks list --project="$PROJECT_ID" --limit=1 >/dev/null 2>&1; then
    echo "Compute API ready after ${attempt}×5s."
    break
  fi
  if [[ "$attempt" == "24" ]]; then
    echo "Compute API still not responding after 120s — aborting. Re-run the script." >&2
    exit 1
  fi
  sleep 5
done

# ---- VPC + subnet ---------------------------------------------------------
if ! gcloud compute networks describe "$VPC_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud compute networks create "$VPC_NAME" \
    --subnet-mode=custom --project="$PROJECT_ID"
fi

if ! gcloud compute networks subnets describe "$SUBNET_NAME" \
     --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud compute networks subnets create "$SUBNET_NAME" \
    --network="$VPC_NAME" \
    --region="$REGION" \
    --range="$SUBNET_CIDR" \
    --project="$PROJECT_ID"
fi

# ---- Serverless VPC Access connector --------------------------------------
if ! gcloud compute networks vpc-access connectors describe "$CONNECTOR_NAME" \
     --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud compute networks vpc-access connectors create "$CONNECTOR_NAME" \
    --network="$VPC_NAME" \
    --region="$REGION" \
    --range="$CONNECTOR_CIDR" \
    --min-instances=2 --max-instances=3 \
    --machine-type=e2-micro \
    --project="$PROJECT_ID"
fi

# ---- Static external IP + Cloud NAT ---------------------------------------
if ! gcloud compute addresses describe "$STATIC_IP_NAME" \
     --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud compute addresses create "$STATIC_IP_NAME" \
    --region="$REGION" --project="$PROJECT_ID"
fi

STATIC_IP="$(gcloud compute addresses describe "$STATIC_IP_NAME" \
  --region="$REGION" --project="$PROJECT_ID" \
  --format='value(address)')"
echo "Reserved static egress IP: $STATIC_IP"

if ! gcloud compute routers describe "$ROUTER_NAME" \
     --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud compute routers create "$ROUTER_NAME" \
    --network="$VPC_NAME" --region="$REGION" --project="$PROJECT_ID"
fi

if ! gcloud compute routers nats describe "$NAT_NAME" \
     --router="$ROUTER_NAME" --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud compute routers nats create "$NAT_NAME" \
    --router="$ROUTER_NAME" \
    --region="$REGION" \
    --nat-all-subnet-ip-ranges \
    --nat-external-ip-pool="$STATIC_IP_NAME" \
    --project="$PROJECT_ID"
else
  # NAT exists — make sure it covers ALL subnets in the VPC, not just the
  # main one. The VPC Connector runs in its own hidden /28 subnet; without
  # "all subnets" NAT coverage, Cloud Run traffic through the connector
  # has no egress path and outbound fetches silently fail.
  run gcloud compute routers nats update "$NAT_NAME" \
    --router="$ROUTER_NAME" \
    --region="$REGION" \
    --nat-all-subnet-ip-ranges \
    --project="$PROJECT_ID"
fi

# ---- Cloud KMS keyring + key (tenant credential envelope encryption) ------
# The runtime SA encrypts/decrypts BT Trade usernames + passwords using this
# key. Key rotation is set to 90 days — old wrapped DEKs keep working because
# KMS tracks versions. `lib/kms.ts` reads the key version back from the
# wrap response and stores it alongside the ciphertext for auditing.
KMS_KEYRING="${KMS_KEYRING:-bt-gateway}"
KMS_KEY="${KMS_KEY:-tenant-creds}"

if ! gcloud kms keyrings describe "$KMS_KEYRING" \
     --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud kms keyrings create "$KMS_KEYRING" \
    --location="$REGION" --project="$PROJECT_ID"
fi

if ! gcloud kms keys describe "$KMS_KEY" \
     --keyring="$KMS_KEYRING" --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud kms keys create "$KMS_KEY" \
    --keyring="$KMS_KEYRING" \
    --location="$REGION" \
    --purpose=encryption \
    --rotation-period=90d \
    --next-rotation-time="$(date -u -v+90d '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -d '+90 days' '+%Y-%m-%dT%H:%M:%SZ')" \
    --project="$PROJECT_ID"
fi

# ---- Artifact Registry ----------------------------------------------------
if ! gcloud artifacts repositories describe "$AR_REPO" \
     --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud artifacts repositories create "$AR_REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="bt-gateway container images" \
    --project="$PROJECT_ID"
fi

# ---- Service accounts -----------------------------------------------------
RUNTIME_SA_EMAIL="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_SA_EMAIL="${DEPLOYER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

for sa_email in "$RUNTIME_SA_EMAIL" "$DEPLOYER_SA_EMAIL"; do
  if ! gcloud iam service-accounts describe "$sa_email" --project="$PROJECT_ID" >/dev/null 2>&1; then
    sa_name="${sa_email%@*}"
    run gcloud iam service-accounts create "$sa_name" \
      --display-name="$sa_name" --project="$PROJECT_ID"
  fi
done

# Runtime SA roles: read/write Firestore, KMS encrypt/decrypt for tenant creds,
# log writer (implicit), and act-as-itself so Cloud Scheduler → Cloud Run can
# use OIDC with this identity.
for role in \
  roles/datastore.user \
  roles/cloudkms.cryptoKeyEncrypterDecrypter \
  roles/secretmanager.secretAccessor; do
  run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role="$role" \
    --condition=None >/dev/null
done

# Deployer SA roles: push images + deploy Cloud Run + act-as the runtime SA.
for role in \
  roles/artifactregistry.writer \
  roles/run.admin \
  roles/iam.serviceAccountUser; do
  run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOYER_SA_EMAIL}" \
    --role="$role" \
    --condition=None >/dev/null
done

# ---- GitHub Actions Workload Identity Federation --------------------------
# Lets the GitHub Actions workflow mint short-lived tokens for $DEPLOYER_SA
# without us ever minting a JSON key. Dramatically better posture than a JSON
# key in repo secrets.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

if ! gcloud iam workload-identity-pools describe "$WIF_POOL_NAME" \
     --location=global --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud iam workload-identity-pools create "$WIF_POOL_NAME" \
    --location=global \
    --display-name="GitHub Actions" \
    --project="$PROJECT_ID"
fi

if ! gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER_NAME" \
     --workload-identity-pool="$WIF_POOL_NAME" \
     --location=global --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER_NAME" \
    --workload-identity-pool="$WIF_POOL_NAME" \
    --location=global \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository == \"${GH_REPO_OWNER}/${GH_REPO_NAME}\"" \
    --project="$PROJECT_ID"
fi

WIF_PROVIDER_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_NAME}/providers/${WIF_PROVIDER_NAME}"

# Allow the GitHub repo's OIDC identity to impersonate the deployer SA.
run gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA_EMAIL" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_NAME}/attribute.repository/${GH_REPO_OWNER}/${GH_REPO_NAME}" \
  --project="$PROJECT_ID" >/dev/null

# ---- Secret Manager secret (cron) -----------------------------------------
# Shared secret the /api/internal/cron/refresh endpoint expects in the
# Authorization header — Cloud Scheduler sends it. Generated once on first
# run, reused forever afterwards so Scheduler jobs don't break on
# re-provision.
#
# (The Telegram webhook secret is per-user and lives in Firestore, not
# Secret Manager. See app/api/ui/telegram/bot — each tenant mints their
# own when they add a bot.)
CRON_SECRET_NAME="bt-gateway-cron-secret"

if ! gcloud secrets describe "$CRON_SECRET_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud secrets create "$CRON_SECRET_NAME" \
    --replication-policy="automatic" --project="$PROJECT_ID"
  # First version: 32 random base64url bytes.
  val="$(openssl rand -base64 32 | tr -d '\n=+/' | cut -c1-40)"
  printf '%s' "$val" | \
    run gcloud secrets versions add "$CRON_SECRET_NAME" \
      --data-file=- --project="$PROJECT_ID"
fi

# Runtime SA gets read access.
run gcloud secrets add-iam-policy-binding "$CRON_SECRET_NAME" \
  --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
  --role=roles/secretmanager.secretAccessor \
  --project="$PROJECT_ID" >/dev/null

CRON_SECRET_VALUE="$(gcloud secrets versions access latest \
  --secret="$CRON_SECRET_NAME" --project="$PROJECT_ID")"

# ---- Cloud Run service (placeholder) --------------------------------------
# We deploy a stub image first so the service exists and CI can `deploy update`
# it on every push. Subsequent deploys replace the image with the real build.
# --allow-unauthenticated: UI must be reachable without gcloud auth; API routes
# do their own API-key / Firebase-ID-token checks in-app.
# --vpc-connector + --vpc-egress=all-traffic: forces all outbound through our
# static-IP NAT. This is the whole point of M1.
if ! gcloud run services describe "$SERVICE_NAME" \
     --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud run deploy "$SERVICE_NAME" \
    --image="gcr.io/cloudrun/hello" \
    --region="$REGION" \
    --platform=managed \
    --allow-unauthenticated \
    --min-instances=1 \
    --max-instances=5 \
    --cpu=1 --memory=512Mi \
    --service-account="$RUNTIME_SA_EMAIL" \
    --vpc-connector="$CONNECTOR_NAME" \
    --vpc-egress=all-traffic \
    --project="$PROJECT_ID"
fi

# ---- Cloud Scheduler: 45-min session refresh -----------------------------
# Keeps BT refresh tokens alive. Sends the shared secret in the
# Authorization header so only our own endpoint accepts it. Recreated each
# run if the URL or header shape changes — gcloud is idempotent on the name
# via the update branch.
SERVICE_URL_FOR_CRON="$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" --project="$PROJECT_ID" \
  --format='value(status.url)')"
CRON_TARGET_URL="${SERVICE_URL_FOR_CRON}/api/internal/cron/refresh"
CRON_JOB_NAME="bt-gateway-refresh-cron"

# Scheduler needs an App Engine app in the project (historical quirk; a free
# tier dummy is fine). If it already exists, this is a no-op.
if ! gcloud app describe --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud app create --region="$REGION" --project="$PROJECT_ID" || true
fi

if ! gcloud scheduler jobs describe "$CRON_JOB_NAME" \
     --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud scheduler jobs create http "$CRON_JOB_NAME" \
    --schedule="*/45 * * * *" \
    --time-zone="UTC" \
    --uri="$CRON_TARGET_URL" \
    --http-method=POST \
    --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
    --attempt-deadline=180s \
    --location="$REGION" \
    --project="$PROJECT_ID"
else
  run gcloud scheduler jobs update http "$CRON_JOB_NAME" \
    --schedule="*/45 * * * *" \
    --time-zone="UTC" \
    --uri="$CRON_TARGET_URL" \
    --http-method=POST \
    --update-headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
    --attempt-deadline=180s \
    --location="$REGION" \
    --project="$PROJECT_ID"
fi

# ---- summary --------------------------------------------------------------
SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" --project="$PROJECT_ID" \
  --format='value(status.url)')"

cat <<EOF

----------------------------------------------------------------------
 M1 infra provisioned.
----------------------------------------------------------------------
 Project            : $PROJECT_ID
 Region             : $REGION
 Static egress IP   : $STATIC_IP
 Cloud Run URL      : $SERVICE_URL
 Runtime SA         : $RUNTIME_SA_EMAIL
 Deployer SA        : $DEPLOYER_SA_EMAIL
 WIF provider       : $WIF_PROVIDER_RESOURCE
 Artifact Registry  : ${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}
 KMS key            : projects/${PROJECT_ID}/locations/${REGION}/keyRings/${KMS_KEYRING}/cryptoKeys/${KMS_KEY}

 Add these to GitHub Actions repository secrets
 (Settings → Secrets and variables → Actions → Repository secrets):

   GCP_PROJECT_ID              = $PROJECT_ID
   GCP_REGION                  = $REGION
   GCP_WIF_PROVIDER            = $WIF_PROVIDER_RESOURCE
   GCP_DEPLOYER_SA             = $DEPLOYER_SA_EMAIL
   GCP_AR_REPO                 = $AR_REPO
   GCP_RUNTIME_SA              = $RUNTIME_SA_EMAIL
   GCP_CONNECTOR               = $CONNECTOR_NAME
   CLOUD_RUN_SERVICE           = $SERVICE_NAME
----------------------------------------------------------------------
EOF
