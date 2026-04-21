# Driving bt-gateway from iOS Shortcuts

bt-gateway exposes a small, stable REST API that's easy to hit from the iOS
Shortcuts app. A single shortcut can "Buy 10 shares of SNP at market" with
one tap from the home screen, Siri, or a widget. The gateway handles the BT
Trade session, the SMS OTP, and the static-IP requirement — Shortcuts only
needs to speak JSON over HTTPS.

## One-time setup

Before the first shortcut works, three things must be in place:

1. **Sign in** to the bt-gateway web UI with Google and save your BT Trade
   credentials for at least one mode (demo or live). See the project
   [README](../README.md) for the full setup walkthrough.
2. **Create an API key** in Settings → Access → *Generate API key*. Pick
   the mode (`demo` or `live`) and a label (e.g. "iPhone — live"). The key
   is shown exactly once — copy it into a Shortcuts variable or a secure
   note on your device.
3. **Note the gateway URL.** It's the Cloud Run host shown in your deploy
   logs — something like `https://bt-gateway-XXXX-ey.a.run.app`.

All calls use two headers:

```
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

Read-only calls (`cash`, `holdings`, `markets`, `instruments/<symbol>`) use
GET. Write calls (`orders`, `orders/preview`) use POST with a JSON body.

## Shortcut 1 — "What's in my portfolio?"

Simplest possible shortcut. Returns holdings, reads out the total P/L.

| Step | Action | Key configuration |
|------|--------|-------------------|
| 1 | **Text** | paste your gateway URL, e.g. `https://bt-gateway-....run.app` |
| 2 | **Text** | paste your API key (Magic Variable this, don't show it) |
| 3 | **Get contents of URL** | URL = output of step 1 + `/api/v1/holdings` |
|   |                         | Method = GET |
|   |                         | Headers: `Authorization` = `Bearer ` + step-2 variable |
| 4 | **Get Dictionary Value** | Get value for `data.positions` |
| 5 | **Repeat with Each** / **Show Result** / etc. | your pick |

To make this Siri-able: add the shortcut to Siri with phrase *"How's my
portfolio"*.

## Shortcut 2 — "Buy N shares of <symbol>"

This one takes inputs and places an order. Build it in two parts: a
**preview** (shows you the price + cost) and a confirmed **place**.

### Inputs

Add three **Ask for Input** steps at the top:

1. Prompt *"Symbol"* → **Text**.
2. Prompt *"Quantity"* → **Number**.
3. Prompt *"Side"* → **Text**. Default `buy`.

Combine them into a JSON dictionary. The Shortcuts *Dictionary* action
produces:

```json
{
  "symbol": "{{symbol}}",
  "side":   "{{side}}",
  "quantity": {{quantity}},
  "orderType": "market"
}
```

### Preview request

| Step | Action | Configuration |
|------|--------|---------------|
| 1 | **Get contents of URL** | URL: `<GATEWAY>/api/v1/orders/preview` |
|   |                         | Method: POST |
|   |                         | Headers: `Authorization: Bearer <KEY>`, `Content-Type: application/json` |
|   |                         | Request body: the JSON dictionary above |
| 2 | **Get Dictionary Value** | `data` key |
| 3 | **Show Alert** | Title: *"Confirm order"*, Body: the preview fields you care about (estimated price, cost, fee). Add **Cancel** + **Place** buttons. |

### Place request (only runs on Place)

Same JSON dictionary, different URL:

- URL: `<GATEWAY>/api/v1/orders`
- Method: POST
- Headers / body: same as preview

On success, the response includes `{ data: { orderId: "...", status: "..." } }`.
Surface that in a **Show Notification** so you can tap through to the
`/orders/<id>` call if you want a live status.

## Shortcut 3 — "Refresh session" (emergency)

If a sign-in failure alert arrives on Telegram, you can kick a fresh login
from your phone:

| Step | Action | Configuration |
|------|--------|---------------|
| 1 | **Get contents of URL** | URL: `<GATEWAY>/api/v1/session/refresh` |
|   |                         | Method: POST |
|   |                         | Headers: `Authorization: Bearer <KEY>` |

This triggers the gateway to attempt a refresh. If the refresh token is
dead, the gateway will fall back to a full login and — crucially — send the
SMS OTP through **ntfy** to your phone (see README). You confirm the OTP
there, and the session is back.

## Good-to-know

- **Timeouts**: BT Trade can be slow; in Shortcuts, *Get contents of URL*
  defaults to 60 s, which is plenty. Don't shorten it.
- **Error handling**: every non-2xx response is `{ "error": { "code":
  "UPSTREAM_UNAVAILABLE", "message": "...", "requestId": "..." } }`. Use
  **If** to branch on the `error` key being present; surface `message` in
  an alert so you know what BT said.
- **Demo vs live keys**: an API key is locked to a mode. A `demo` key
  cannot touch a live account, even if you mistype the URL. The key prefix
  (`bvb_demo_...` / `bvb_live_...`) is a visual reminder.
- **Siri + widget**: the *Buy N shares* shortcut works great as a Home
  Screen widget — make a separate one per common symbol/quantity for
  one-tap orders.

## Example: complete "Buy 10 SNP at market" shortcut (no prompts)

For a truly one-tap action, hard-code everything. Useful for a widget.

```json
POST <GATEWAY>/api/v1/orders
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "symbol": "SNP",
  "side": "buy",
  "quantity": 10,
  "orderType": "market"
}
```

Wire that single *Get contents of URL* action, add a final **Show
Notification** with `data.orderId`, done. One tap from the lock screen
places the order.

> **Safety reminder**: anything with `orderType: "market"` on `live` fills
> at the best available price *now*, regardless of movement since you last
> looked. Prefer `orderType: "limit"` with a `limitPrice` field for
> anything you're not actively watching.
