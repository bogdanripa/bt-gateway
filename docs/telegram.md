# Telegram setup

bt-gateway uses Telegram to alert you when a sign-in to BT Trade happens or,
more importantly, when one **fails** (e.g. the refresh token expired and the
next API call will require a fresh SMS OTP). Routine 45-minute background
refreshes do **not** send a message — only events you might actually want to
act on.

Each bt-gateway user brings their own bot. There is no shared bot. This means:

- The bot's @handle is yours. You control it, you can rename it.
- Only you can DM your bot and have it do anything useful (the webhook
  requires a valid link code that only you can generate in the UI).
- Your bot token is stored encrypted via Cloud KMS. The server never logs it.

One-time setup takes about three minutes.

## 1. Create a bot in Telegram

1. In the Telegram app, open a chat with **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot`.
3. Give it a display name (whatever you want — e.g. *"BT Trade alerts"*).
4. Give it a username ending in `bot` (must be globally unique —
   e.g. `bogdan_bt_alerts_bot`). Telegram will tell you if it's taken.
5. BotFather replies with a message containing your **bot token** — a long
   string that looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`.
   **Copy this — it's the only time Telegram shows it.**

Optional but nice:

- Send `/setdescription` to give the bot a tagline.
- Send `/setuserpic` to upload an icon.

## 2. Paste the token into bt-gateway

1. Open the bt-gateway web UI → **Settings → Notifications → Telegram bot**.
2. Click **Add bot**, paste the token, click **Save bot**.
3. The server verifies the token with Telegram, stores it encrypted, and
   shows you a **Webhook URL**. Copy that URL.

## 3. Point Telegram at the webhook

Telegram pushes DMs your bot receives to the URL you register. Run this
once (anywhere — your laptop, Cloud Shell, a throwaway terminal). Replace
`<TOKEN>` with the BotFather token and `<WEBHOOK_URL>` with the value the
UI gave you:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=<WEBHOOK_URL>"
```

You should get `{"ok":true,"result":true,"description":"Webhook was set"}`.

(The Settings UI shows the exact curl command with your webhook URL
filled in — copy-paste it.)

## 4. Link your personal chat

The bot can now receive messages, but bt-gateway doesn't yet know which
Telegram user is you. To prove identity:

1. In Settings, in the **Chat link** card, click **Generate link code**.
2. You get an 8-character code and a one-click **Open bot** link.
3. Open the bot in Telegram and send `/start <code>` (the link pre-fills it).
4. The bot replies "Linked." — you're done.

Codes expire after 10 minutes. Generate a new one if needed.

## Rotating or removing the bot

- **Rotate the token** (e.g. you regenerated it with `/revoke` in BotFather):
  click **Rotate token** in the UI, paste the new token. The webhook URL
  stays the same — you do NOT need to re-run `setWebhook`.
- **Switch to a different bot**: same as rotate, but the chat link is cleared
  (the old link points to a chat on a bot that isn't ours anymore). Re-link
  after pasting the new token.
- **Remove** deletes both the bot config and the chat link.

## Troubleshooting

- **"Telegram did not accept that token"** on save — the token is wrong or
  expired. Double-check you copied the whole thing from BotFather (it's one
  line, no spaces).
- **`/start <code>` replies "invalid or expired"** — codes live 10 minutes
  and only the most recent one is valid. Generate a fresh one.
- **No alert arrives on a real sign-in failure** — check Settings shows both
  *bot configured* and *chat linked*. Also verify the webhook is set by:
  ```bash
  curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
  ```
  The `url` should match what the UI shows, and `last_error_message` should
  be empty. If it's non-empty, Telegram is telling you why deliveries are
  failing (usually stale URL after a Cloud Run domain change).
