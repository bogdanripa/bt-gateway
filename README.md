# bt-gateway

Multi-tenant HTTP gateway in front of BT Trade (Banca Transilvania's retail
platform). Runs on Cloud Run with a **static egress IP** so BT's refresh
tokens survive across invocations — the whole reason this service exists.

## Why this exists

BT Trade pins session refresh tokens to the IP that issued them. Ephemeral
sandboxes (Claude Code routines, Cloud Run with default egress, GitHub
Actions) rotate egress IPs on every fire, so stored refresh tokens are
rejected with `IP diferit` and every run triggers a fresh 2FA login.

This gateway terminates that problem:

- One always-warm Cloud Run instance (`min-instances=1`)
- All egress forced through a Serverless VPC Connector into a Cloud NAT with
  a reserved static external IP
- Per-tenant `BTTradeClient` kept warm in memory, snapshotted to Firestore
- Internal 45-min cron refresh keeps tokens rotating server-side
- Clients (your trading routine, the web UI) never handle BT creds or tokens;
  they talk to the gateway over HTTPS with API keys / Firebase ID tokens

## Architecture (target state — built in milestones)

```
Trading routines ──────┐
                       │  API key
                       ▼
Browser (UI) ──────► Cloud Run (Next.js: API routes + pages)
  (Firebase Auth)      │          ├── per-tenant BT client pool
                       │          ├── Firestore (europe-west3)
                       │          │    users/{uid}/bt_creds         (KMS-wrapped)
                       │          │    users/{uid}/bt_session       (token snapshot)
                       │          │    users/{uid}/api_keys/{kid}
                       │          │    users/{uid}/events/{eid}     (audit log)
                       │          ├── Cloud KMS (creds encryption)
                       │          └── Telegram bot (shared, /start links chat_id)
                       │
                       └── egress via VPC Connector → Cloud NAT
                            (static IP → BT Trade)

Cloud Scheduler ────► /internal/cron/refresh (OIDC-authed, every 45 min)
```

## Milestones

| | Exit criterion |
|---|---|
| **M1** — Infra foundation (this) | `/api/health` returns the same `egressIp` 20 times in a row |
| **M2** — Auth + tenants + core gateway | curl places a demo order through the API |
| **M3** — Web UI | Sign in with Google, enter BT creds, create API key, see full audit trace |
| **M4** — Cron + Telegram + migrate `auto-trading` | Morning routine runs end-to-end against the gateway |

## First-time setup

Prereqs on your workstation: `gcloud` authed as owner of `auto-trader-493814`,
Docker, Node 20+, GitHub CLI (optional).

```bash
# 1. Provision the GCP side (VPC, NAT, static IP, Artifact Registry, SAs,
#    Workload Identity Federation, placeholder Cloud Run service).
./infra/provision-m1.sh

# 2. Copy the secrets it prints into this GitHub repo's Actions secrets:
#      GCP_PROJECT_ID, GCP_REGION, GCP_WIF_PROVIDER, GCP_DEPLOYER_SA,
#      GCP_AR_REPO, GCP_RUNTIME_SA, GCP_CONNECTOR, CLOUD_RUN_SERVICE

# 3. Push to main. GitHub Actions builds the image, pushes to Artifact
#    Registry, and redeploys the Cloud Run service.
git push origin main

# 4. M1 smoke test — confirm the static egress IP holds.
URL="$(gcloud run services describe bt-gateway \
        --region=europe-west3 --project=auto-trader-493814 \
        --format='value(status.url)')"
for i in $(seq 1 20); do curl -s "$URL/api/health" | jq -r .egressIp; done | sort -u
# Expected output: exactly one line (the reserved static IP).
```

## Local dev

```bash
npm install
npm run dev
open http://localhost:3000/api/health
```

Local dev does not touch GCP — no static IP, no KMS, no Firestore auth. It's
purely for UI iteration. Anything that requires BT Trade or Firestore is
deployed and tested against the Cloud Run service.

## Security posture

- **Credentials**: BT Trade passwords are envelope-encrypted with Cloud KMS.
  The runtime service account holds `roles/cloudkms.cryptoKeyEncrypterDecrypter`
  on exactly one key. Passwords never appear in logs or API responses.
- **Deploy identity**: GitHub Actions uses Workload Identity Federation — no
  JSON keys in repo secrets. The deployer SA can push images + deploy Cloud
  Run but cannot read Firestore tenant data.
- **API keys**: SHA-256 hashed at rest, shown once at creation, scoped per
  tenant, revocable from the UI.
- **Tenant isolation**: every API route resolves the caller's tenant first and
  scopes every Firestore read/write to `users/{uid}/...`. No cross-tenant
  access paths.

## License

Private. Not open for public use.
