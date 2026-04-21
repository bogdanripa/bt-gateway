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
    --nat-custom-subnet-ip-ranges="$SUBNET_NAME" \
    --nat-external-ip-pool="$STATIC_IP_NAME" \
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
