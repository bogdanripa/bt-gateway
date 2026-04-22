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

### 0. Discover the account (run BEFORE prompting the user)

**Do not ask the user to change filter configuration yet.** Before running any scenario that depends on specific symbols/currencies, probe the account with the key's filters already empty (or whatever they currently are — tolerate filtered results here) and figure out what's actually there. The account shape varies per user, so later scenarios must be tailored, not hardcoded.

Steps:
1. `GET /api/v1/cash` → record the set of currencies present (`BASELINE_CASH_CURRENCIES`).
2. `GET /api/v1/holdings` → record:
   - `HELD_SYMBOLS` = `Positions.Items[].Code` (unique, sorted)
   - `HELD_CURRENCIES` = `Positions.Items[].Currency` (unique, sorted)
   - `HELD_MARKETS` = `Positions.Items[].Market` (unique, sorted)
   - `RATE_CURRENCIES` = `Total.CurrencyRates[].Name` (unique, sorted)
3. `GET /api/v1/orders?statuses=ACTIVA` → record `ACTIVE_ORDER_COUNT`. 502 is acceptable (no active orders session) — just note it.

Then pick the test fixtures and print them to the user so they know what the rest of the run will use:
- `HELD_PICK` = the first held symbol that is **RON-denominated and on BVB** if any exists, else the first held symbol. Used for `stocks.include` scenarios.
- `EXCLUDE_PICK` = a held symbol to exclude (pick any, prefer the largest-percentage position if the data is available, else the first). Used for `stocks.exclude` scenarios. Must actually be in `HELD_SYMBOLS` — otherwise the exclude has no visible effect.
- `NOT_HELD_PICK` = a symbol known to exist on BVB but NOT in `HELD_SYMBOLS`. Candidates to try in order: `TLV`, `SNP`, `BRD`, `H2O`, `TEL` — probe `GET /api/v1/instruments/<sym>` with NO filters and pick the first that returns 200 and isn't held. Used as the "blocked via exclude" probe target AND the single-resource 403 target.
- `FOREIGN_CURRENCY_PICK` = a currency present in `HELD_CURRENCIES` that is NOT `RON`, if any (e.g. `USD`, `EUR`, `GBP`). Used to verify `currencies.include=[RON]` actually drops foreign-denominated positions. If all holdings are RON, skip the currency-scope assertions on `Positions.Items` and note it.

Print a short summary like:
```
Account shape:
  cash currencies:   [RON]
  held symbols (9):  CHTU, IU5D, MCHT, TSLA, VUAA, EMXC, EXSA, LEER, VHYL
  held currencies:   [EUR, GBP, RON, USD]   (foreign present → currency-scope checks valid)
  held markets:      [BVB, XETRA, LSE, NASDAQ]
  active orders:     0 (or 502)

Picks for this run:
  HELD_PICK           = VUAA
  EXCLUDE_PICK        = TSLA
  NOT_HELD_PICK       = TLV
  FOREIGN_CURRENCY    = USD
```

Store these in shell variables that persist across scenarios (declare them in every `Bash` invocation that needs them, since shell state does NOT persist between tool calls — keep the values in your own notes and re-inject them).

### 1. Baseline — no filters
- Filters: `markets`, `currencies`, `stocks` all `{ include: [], exclude: [] }`.
- Calls: same three as discovery, but this time with filters guaranteed empty.
- Assertion: all calls return 200 (orders can be 502 if no session has active orders — note but don't fail). Numbers should match discovery.
- Mark PASS if all green and `HELD_SYMBOLS` non-empty. If holdings is empty, mark INCONCLUSIVE and note that later scenarios can't validate.
- **Known gap** (as of 2026-04-22): `/api/v1/cash` currently resolves a single evaluation currency (RON) and calls BT once, so USD/EUR cash balances never surface. If the user confirms they hold non-RON cash but the endpoint returns RON only, flag this as a bug — do not mark the scenario FAIL on that basis alone.

### 2. Currency only RON
- Filters: `currencies.include = [RON]`, everything else empty.
- Calls: `cash`, `holdings`.
- Assertions:
  - `cash[*].value.currency` (or `cash.currency` on bare entries) only contains `RON`.
  - `holdings.Total.CurrencyRates[*].Name` only contains `RON` (this one has historically been leaky — CurrencyRates showed EUR/GBP/USD despite the filter).
  - `holdings.Positions.Items[*].Currency` only contains `RON`. Every position whose `Currency` is in `FOREIGN_CURRENCY_PICK` (or any non-RON value from discovery) should be dropped, and `Positions.TotalItemCount` should match the filtered length. If discovery found no foreign currencies, skip this assertion and note it.
  - `holdings.Total.Positions[?].MoneyBalances` (the Numerar row) only contains RON entries.
- PASS only if every applicable check passes. If `CurrencyRates` or per-position currencies still leak non-RON values, mark FAIL and name the exact leaking field.

### 3. Stock exclude (held symbol)
- Filters: reset, then `stocks.exclude = [EXCLUDE_PICK]` (a symbol that IS in `HELD_SYMBOLS` — otherwise the assertion is trivially green and tests nothing).
- Calls: `holdings`, and if `ACTIVE_ORDER_COUNT > 0`: `orders?statuses=ACTIVA`.
- Assertions:
  - `holdings.Positions.Items[*].Code` does NOT contain `EXCLUDE_PICK`.
  - `holdings.Positions.TotalItemCount` equals baseline_count − 1 (or equal-minus-N if `EXCLUDE_PICK` appeared multiple times).
  - If `orders` is called, `Items[*].Code` does NOT contain `EXCLUDE_PICK`.
- Also run a single-resource probe:
  - `GET /api/v1/instruments/<EXCLUDE_PICK>` → expect **403 FORBIDDEN**.
- PASS if holdings/orders lists dropped the symbol AND the instrument probe is 403.

### 4. Stock include (held symbol only)
- Filters: reset, then `stocks.include = [HELD_PICK]` (a symbol that IS in `HELD_SYMBOLS`).
- Calls: `holdings`.
- Assertions:
  - `holdings.Positions.Items[*].Code` is a subset of `{HELD_PICK}`.
  - `holdings.Positions.TotalItemCount` equals the number of kept rows (typically 1).
- Also probe:
  - `GET /api/v1/instruments/<HELD_PICK>` → expect 200.
  - `GET /api/v1/instruments/<NOT_HELD_PICK>` → expect 403 (not in the include list).
  - If `EXCLUDE_PICK !== HELD_PICK`, also probe `/api/v1/instruments/<EXCLUDE_PICK>` → expect 403.
- PASS accordingly.

### 5. Mutation rejection
- Filters: `stocks.exclude = [EXCLUDE_PICK]` (a symbol the user actually cares about blocking — use the same pick as scenario 3).
- Call:
  ```bash
  curl -sS -w '\nHTTP %{http_code}\n' -X POST "$BASE/api/v1/orders/preview" \
    -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
    -d "{\"symbol\":\"$EXCLUDE_PICK\",\"side\":\"buy\",\"price\":40,\"type\":\"limit\"}"
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
