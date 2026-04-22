---
name: filter-tests
description: Interactive test harness for per-API-key filter rules on bt-gateway. Walks the user through a set of filter-configuration scenarios, hits the gateway with their API key after each change, and prints a focused diff of what the filter did vs what the response actually contained. Invoke with `/filter-tests` (optionally with the API key and/or gateway URL as args).
---

# Filter tests

You are running an interactive test harness for the per-API-key filter feature on bt-gateway. The goal is to verify that `currencies.include`, `stocks.include`, `stocks.exclude`, and market filters behave correctly across `/api/v1/cash`, `/api/v1/holdings`, `/api/v1/orders`, and the single-resource endpoints.

## Inputs

Parse these from `$ARGUMENTS` (whitespace-separated). If either is missing, ask the user for it before starting.

- `API_KEY` — first non-URL token. Must start with `bvb_demo_` or `bvb_live_`.
- `BASE_URL` — first `http(s)://…` token. Default: `https://bt-gateway-o2qixn6u6q-ey.a.run.app`.

Never log the API key beyond its first 12 chars (`bvb_<mode>_XXX`). Use it only in `Authorization: Bearer` headers passed to `curl`.

## Flow

1. Greet the user. Confirm `BASE_URL` and the key's prefix + mode.
2. Ask: **"Paste 'start' when you've signed in to the gateway web UI and opened Settings → API keys, ready to edit this key's filters."**
3. For each scenario below, in order:
   - Print the scenario number, title, and the filter configuration to set.
   - Ask: **"Set those filters on the key, save, then reply 'done' (or 'skip' to skip, 'stop' to end)."**
   - On `done`: run the scenario's checks via `Bash` + `curl` + `jq`, print a focused result, and mark PASS/FAIL.
   - On `skip`: mark SKIPPED and continue.
   - On `stop`: end the loop and print the summary.
4. When all scenarios are done (or stopped), print a summary table: scenario | result | notes.

Keep outputs tight. For each call, show:
- HTTP status
- Key filter-relevant counts (e.g., `cash.length`, `holdings.Positions.Items.length`, `holdings.Positions.TotalItemCount`, `holdings.Total.CurrencyRates` names, `orders.Items.length`)
- A PASS/FAIL line explaining the assertion

Do NOT dump full JSON responses — that's noisy and often contains tokens/IDs. Only surface what's needed to judge the assertion.

## Scenarios

### 1. Baseline — no filters
- Filters: `markets`, `currencies`, `stocks` all `{ include: [], exclude: [] }`.
- Calls:
  - `GET /api/v1/cash` → record cash currency codes.
  - `GET /api/v1/holdings` → record `Positions.Items[].Code` (the symbol list) and `Total.CurrencyRates[].Name`.
  - `GET /api/v1/orders?statuses=ACTIVA` → record `Items.length` (may be 0 if no active orders — that's fine, just note it).
- Assertion: all calls return 200. Remember the baseline symbols and currencies for later comparisons. Store them in shell variables or a note so subsequent scenarios can diff.
- Mark PASS if all three are 200 and we have a non-empty holdings set. If holdings is empty, mark INCONCLUSIVE and note that we can't validate later scenarios without some positions.

### 2. Currency only RON
- Filters: `currencies.include = [RON]`, everything else empty.
- Calls: `cash`, `holdings`.
- Assertions:
  - `cash[*].value.currency` (or `cash.currency` on bare entries) only contains `RON`.
  - `holdings.Total.CurrencyRates[*].Name` only contains `RON`.
  - `holdings.Total.Positions[?].MoneyBalances` (the Numerar row) only contains RON entries.
- PASS if all three.

### 3. Stock exclude TLV
- Filters: reset, then `stocks.exclude = [TLV]`.
- Calls: `holdings`, and if baseline had any orders: `orders?statuses=ACTIVA`.
- Assertions:
  - `holdings.Positions.Items[*].Code` does NOT contain `TLV`.
  - `holdings.Positions.TotalItemCount` reflects the filtered length.
  - If `orders` endpoint returns a `PaginatedResult`, `Items[*].Code` does NOT contain `TLV`.
- Also run a single-resource probe:
  - `GET /api/v1/instruments/TLV` → expect 403 `FORBIDDEN`.
- PASS if holdings/orders lists are TLV-free AND the instrument probe is 403.

### 4. Stock include only BRD
- Filters: reset, then `stocks.include = [BRD]`.
- Calls: `holdings`.
- Assertions:
  - `holdings.Positions.Items[*].Code` is a subset of `{BRD}` (or empty if BRD isn't held).
  - `holdings.Positions.TotalItemCount` equals the filtered length.
- Also probe:
  - `GET /api/v1/instruments/BRD` → expect 200.
  - `GET /api/v1/instruments/TLV` → expect 403.
- PASS accordingly.

### 5. Mutation rejection
- Filters: `stocks.exclude = [TLV]`.
- Call:
  ```bash
  curl -sS -w '\nHTTP %{http_code}\n' -X POST "$BASE/api/v1/orders/preview" \
    -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
    -d '{"symbol":"TLV","side":"buy","price":40,"type":"limit"}'
  ```
- Expect: HTTP 403 and `error.code = FORBIDDEN`. Do NOT call the real `/orders` POST — preview is enough to verify the guard and doesn't mutate.
- PASS if 403 + code=FORBIDDEN.

### 6. Cleanup prompt
Ask the user to reset their key's filters to empty so they aren't left in a restricted state. No API calls here.

## Implementation hints

- Use `curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $KEY"` and split the body vs status at the trailing newline.
- Pipe JSON responses through `jq` for assertions. Example for the holdings symbol list:
  ```bash
  curl -sS -H "Authorization: Bearer $KEY" "$BASE/api/v1/holdings" \
    | jq -r '.holdings.Positions.Items[].Code'
  ```
- When comparing against the baseline, keep the baseline values in shell variables in the same Bash invocation block so they persist:
  ```bash
  BASE_SYMS=$(curl -sS … | jq -r '.holdings.Positions.Items[].Code' | sort -u)
  ```
- If the gateway session expired and a scenario returns 401/502, prompt the user to hit Refresh in the web UI and retry, rather than failing the scenario.

## End

After the summary table, print:
```
Filters are persisted on the key. Remember to reset them via Settings → API keys if you want to use this key unrestricted.
```
