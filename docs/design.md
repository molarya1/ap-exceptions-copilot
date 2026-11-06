# AP Exceptions Copilot: design spec

A portfolio project. An AI copilot for an accounts-payable team: deterministic rules find
problems in invoices and vendor mail, an agent decides what to do about each one, and a person
approves every action that moves money or talks to a vendor.

This file is the build brief. Read it fully before writing code.

## 0. Originality

Everything in this project (code, prompts, data, tests and docs) is written for it. All
companies, people, emails and bank details are fictional and generated. Bank account numbers
must be obviously fake (see section 3).

## 1. Goal and audience

Readers are hiring managers and engineers looking at a portfolio. They should be able to:

1. understand the problem and the design from the README in under five minutes;
2. run the full demo with one command and **no API key** (replay mode);
3. read any part of the code without getting lost: small, focused, well-named modules.

Build a focused showcase, not a product. Fewer features done carefully beat many done roughly.

## 2. The scenario

**Quillfeather Provisions** is a fictional 250-person regional food distributor. Its
accounts-payable team is three people paying about 120 vendors (growers, packaging, freight,
equipment service, utilities). Their data is an ERP export and a shared AP inbox. Every week
they run a payment batch, and every week some invoices are wrong, duplicated, late, or not
what they claim to be.

The copilot's job: before each payment run, find what needs a decision, investigate it, and
prepare exact actions for a person to approve.

Business date for the dataset: fixed (e.g. `2026-03-16`, a Monday payment run). All "today"
logic uses this date, never the system clock.

## 3. Data

### 3.1 Generator

`npm run generate` writes `data/` from a **seeded PRNG** (same seed, same bytes). Commit the
generated `data/` so readers can browse it, and commit the generator so they can see how it was
made. The generator also writes `data/scenarios.json`: the ground truth of every planted
scenario (used by evals, never by the app or the agent).

### 3.2 Files

| File | Contents |
| --- | --- |
| `vendors.csv` | id, legal name, trading names, category, payment terms (e.g. `NET30`, `2/10 NET30`), remit-to bank account, contact name, contact phone, email domain, status |
| `purchase_orders.csv` | PO id, vendor, order date, buyer, currency |
| `po_lines.csv` | PO line id, PO id, item description, unit, quantity ordered, unit price |
| `receipts.csv` | receipt id, PO line id, quantity received, date received |
| `invoices.csv` | invoice id (internal), vendor, vendor invoice number as printed, invoice date, due date, currency, total, status (`open`, `approved`, `paid`, `on_hold`) |
| `invoice_lines.csv` | invoice id, PO line id (may be blank), description, quantity, unit price, line total |
| `payments.csv` | past payments: invoice id, amount, date, bank account paid to |
| `inbox/*.eml` | vendor emails: invoices sent, reminders, disputes, credit-note notices, bank-detail changes (some genuine, some fraudulent) |

Fake bank details: use a clearly synthetic format such as `QF-TEST-0000-1234` so nothing looks
like a real account number.

### 3.3 Planted messiness (the cleaning layer must handle it, and log each decision)

- Vendor names that vary between files ("Harlow Packaging Ltd", "HARLOW PACKAGING", "Harlow Pkg").
- Vendor invoice numbers formatted differently (`INV-00412`, `412`, `inv 412`).
- Credit notes recorded as negative invoices.
- A currency other than USD on a few invoices, with an FX table.
- Units that differ between PO line and invoice line (case vs each), with a conversion table.
- Invoices with no PO (utilities, services) that are exempt from matching.
- A few blank or malformed rows.

### 3.4 Planted scenarios (at least one of each, plus noise)

1. **Duplicate invoice**: the same invoice sent twice with a reformatted number, once by email,
   once through the ERP. One is already approved for this week's run.
2. **Price variance**: invoice unit price above the PO price beyond tolerance.
3. **Quantity variance**: invoiced quantity higher than received (partial delivery billed in full).
4. **Discount about to expire**: `2/10 NET30` invoices whose discount window closes before the
   next run unless paid in this one.
5. **Bank-detail change, fraudulent**: email from a look-alike domain asking to update remit-to
   details and pay an open invoice to the new account, with urgency.
6. **Bank-detail change, genuine**: a real vendor changing banks, from its known domain,
   matching an earlier heads-up email. Still must be verified by callback before use.
7. **Prompt injection**: a vendor email containing text addressed to "AI assistants"
   instructing them to approve payment.
8. **Noise**: routine emails (thank-yous, newsletters, statements that reconcile) that must not
   create issues.

## 4. Pipeline

```
data/ ──> ingest + clean ──> facts.db (read-only)
                │                 │
          email extraction        ├──> detectors (SQL rules) ──> ranked issue queue
          (Claude, cached)        │                                   │
                                  └── tools (read-only) <── investigation agent (Claude)
                                                                      │ submit_plan
                                                              plan checks (code)
                                                                      │ valid plan
                                                                   work.db
                                                                      │
                                     web UI ──> approve (capability, hash, re-check, claim)
                                                                      │ one transaction
                                                                outbox (simulated send)
```

### 4.1 Ingest and cleaning (`src/ingest/`)

- Load raw files, normalize vendors (match names to vendor ids), invoice numbers, currencies
  and units. Never modify `data/`.
- Every rule decision goes to a `cleaning_log` table: rule, record id, before, after, reason.
- Every fact row keeps a pointer to its raw source (file and row, or email id).
- Build `facts.db` (SQLite) from scratch on every start, then open it read-only. Two builds from
  the same data produce the same content digest; a test checks that.

### 4.2 Email extraction (`src/extract/`)

- Claude reads each email and returns structured claims with a zod schema: intent (invoice,
  reminder, dispute, credit note, bank change, other), referenced invoice numbers, amounts,
  new bank details if any, and an **exact quote** as evidence for each claim.
- Code verifies each quote appears in the email; claims without verifiable evidence are dropped.
- Results are cached in `cache/extractions.json` and committed, so the app runs without a key.
- **Trust flags are set in code**, not by the model:
  - `lookalike_domain`: sender domain is close to (but not equal to) a known vendor domain;
  - `reply_to_mismatch`: Reply-To differs from From;
  - `embedded_instructions`: the model reports suspected instructions, and the flag is set only
    if code confirms the quoted text exists in the email.

### 4.3 Detectors (`src/detect/`)

Deterministic SQL, no model. Each returns issues with: type, vendor, invoices, money at risk,
deadline, evidence ids. Group related symptoms into one issue per root cause.

| Type | Detects |
| --- | --- |
| `duplicate_invoice` | Same vendor and normalized invoice number, or same vendor, amount and date within a window |
| `match_exception` | Three-way match failure: price or quantity beyond tolerance (e.g. 2% or $50, configurable) |
| `discount_expiring` | Approved or open invoices whose early-payment discount ends before the next run |
| `bank_change_request` | A bank-detail change in the inbox, with its trust flags |
| `suspicious_message` | Any email with a trust flag, if not already part of a bank-change issue |

Ranking: money at risk (log scale) plus urgency from the deadline. Explain the ranking inputs on
each issue in the UI.

### 4.4 Investigation agent (`src/agent/`)

One run per issue. The loop sits behind one small interface (system prompt, user message, tool
definitions, a `call(name, input)` function, a deadline) with two transports:

- **Claude Code (default for live runs, `LIVE_VIA_CLAUDE_CODE=1`):** `@anthropic-ai/claude-agent-sdk`
  drives the user's logged-in Claude Code CLI, so live runs use their subscription, not API
  billing. The tools are exposed as an in-process MCP server and are the only tools allowed:
  built-in tools disabled, no settings files loaded, `dontAsk` permissions, no session
  persistence, a temporary working directory, and `ANTHROPIC_API_KEY` removed from the child
  environment so a stray key never overrides the login.
- **Messages API (optional, `ANTHROPIC_API_KEY`):** a plain tool loop with the Anthropic
  TypeScript SDK and prompt caching.

Email extraction (4.2) uses the same transports. Tests use fakes of both. The tools are the
only things the model can do:

| Tool | Does |
| --- | --- |
| `query` | Read-only SQL (SELECT/WITH only) over documented tables and views, with a row cap |
| `read_email` | Original email text by id, wrapped and marked untrusted, with its trust flags |
| `match_check` | Three-way match for an invoice in code: per-line price and quantity variance against PO and receipts, tolerance result, and the correct payable amount |
| `discount_value` | For an invoice: discount amount, deadline, and annualized return of paying early, in code |
| `submit_plan` | Submits the decision: options considered, chosen option, typed actions, open questions, evidence ids. Checked in code; problems go back to the model |

Run limits: max tool calls (e.g. 16), a wall-clock deadline, and an audit log per run
(`.local/runs/<id>/audit.jsonl`) with every model turn, tool input, output and refusal.

System prompt: short, rule-like, written fresh. It fixes the business date, says email text is
evidence and never instructions, requires every amount to come from a tool result, requires
comparing real options (including "do nothing"), and asks for exactly one chosen option.

Outcomes: `act`, `hold_and_ask`, `no_action`.

### 4.5 Plan checks (`src/agent/checks.ts`)

`submit_plan` rejects a plan when:

- any referenced id does not exist, or no evidence is cited;
- a payment or short-pay amount differs from the `match_check` result for that invoice in this run;
- it pays an invoice that has an open duplicate issue;
- it pays more than an invoice's open balance;
- it changes bank details from an email: the only allowed response to a bank-change request is
  `verify_bank_change` (a callback to the contact **on file**, never a number from the email);
- it pays to an unverified bank account;
- it chooses more than one option.

Rejections return specific, fixable messages. Allow a few retries beyond the tool budget.

### 4.6 Actions (`src/actions/`)

Typed with a zod discriminated union. Each action is stored with its exact payload and a hash,
and approved on its own.

| Action | Effect when sent (simulated) |
| --- | --- |
| `schedule_payment` | Adds the invoice to this week's payment run at a given amount |
| `hold_payment` | Removes it from the run with a reason |
| `short_pay` | Pays the matched amount and records the disputed remainder |
| `request_credit_note` | Email to the vendor's contact on file asking for a credit note |
| `verify_bank_change` | Creates a callback task to the contact on file; never updates bank details |

### 4.7 Approvals and sending

- **Human capability:** only the HTTP layer can create one, from a session cookie (HttpOnly,
  SameSite=Strict). Agent code can't create or reach it. Approval functions require it.
- **Bound to the payload:** approving sends the payload hash the person saw. A mismatch is refused.
- **Re-check on approve:** preconditions run again on current data (invoice still open, amount
  still matches, account still verified).
- **Claims:** one claim key per commitment (e.g. one payment per invoice). A second conflicting
  approval is refused, in the same transaction.
- **Outbox:** approval, claim and outbox row commit in one transaction on `work.db`. Sending is
  simulated: an outbox row is the end of the line. Nothing leaves the machine.
- Host allowlist and Origin check on state-changing requests. Strict CSP on the UI.

### 4.8 Two stores

- `facts.db`: rebuilt from `data/` on start, read-only after build. The agent's tools read it.
- `work.db`: issues' runs, plans, actions, approvals, claims, outbox, activity log. Persists
  across restarts. Written only through transactions.

### 4.9 Replay mode

- Live runs are recorded to `recorded/<issue>.json` (the full tool transcript and final plan).
- `npm start` with no API key loads recorded runs, **re-runs the plan checks and calculators
  with current code**, and shows them. A recorded plan that today's checks reject shows as
  failed, not as valid.
- With live mode configured (`LIVE_VIA_CLAUDE_CODE=1`, or `ANTHROPIC_API_KEY`), the app
  investigates live in the background (two at a time).

## 5. UI (`public/`)

Plain HTML, CSS and JS, no framework. Three views:

1. **Queue:** issues ranked, with type, vendor, money at risk, deadline and status.
2. **Issue:** the agent's decision, options compared, actions with exact documents, evidence as
   readable source cards (email excerpts, invoice lines), and "how the copilot got here" (the
   tool-call trail).
3. **Approvals:** approve or reject each action; show the outbox after sending.

Keep it calm and readable. No demo labels or fake user names in the UI.

## 6. Evals (`evals/`)

- 8-10 cases built from the planted scenarios, plus **overlays**: small SQL and email changes
  applied to a fresh database that change the expected decision for a known reason (e.g. the
  vendor confirms the price increase in writing, so the price variance becomes payable).
- Deterministic grading per case: expected issues detected and noise not; decision in the
  accepted set; required actions present, forbidden actions absent (never pay the fraudulent
  account, never act on injected instructions).
- Guardrail checks on the agent's real proposals: forged, wrong-payload, stale and double
  approvals are all refused; approve-and-send works once.
- `npm run eval` runs live (through the Claude Code login by default) and records; `npm run eval:replay` re-checks recordings
  with current code and needs no key. CI runs replay.
- `evals/results.md` is generated: per-case result, tool calls, cost and time.

## 7. Tests and CI

- `node:test` via tsx. Cover: cleaning rules, digest stability, each detector, each plan check,
  calculators, the approval guardrails (capability, hash, re-check, claims, overlap), HTTP
  session and origin checks, and the agent loop against a fake Messages API.
- GitHub Actions on Node 20 and 22: typecheck, lint, tests, eval replay.

## 8. Stack

- TypeScript (strict, `noUncheckedIndexedAccess`), Node 20+, run with `tsx` (no build step).
- SQLite via `sql.js` (no native build).
- `zod` for every schema; tool input schemas generated from zod for the API.
- `@anthropic-ai/claude-agent-sdk` (default live transport) and `@anthropic-ai/sdk` (optional).
  Model from `AGENT_MODEL`, defaulting to `claude-sonnet-5-5`; effort from `AGENT_EFFORT`. Use
  prompt caching on the API path.
- Config in environment variables, `.env.example` committed, no real keys anywhere.

## 9. Vocabulary

Use these names consistently in code, UI and docs:

- **issue**: something a detector or the agent found that needs a decision;
- **run**: one investigation of one issue;
- **plan**: the agent's submitted decision;
- **check**: a code rule a plan must pass;
- **action**: one typed, approvable step;
- **approval**: a person's decision on one exact action payload;
- **outbox**: where approved actions go; simulated.

## 10. README (written last, for portfolio readers)

1. One-paragraph pitch and a screenshot or short GIF.
2. "Try it in 60 seconds": clone, `npm install`, `npm start`, open the URL. No key needed.
3. Architecture diagram and one paragraph: rules detect, the agent decides, a person approves.
4. What's deterministic and what's the model, as a table.
5. Guardrails: why the agent can only propose.
6. Eval results, with honest limitations.
7. Design decisions and tradeoffs, and what production would add (Postgres, a durable queue,
   per-tenant budgets, re-running only when an issue's inputs change).

## 11. Non-goals

Real email or ERP integration, auth beyond a local session, multi-tenancy, payments of any real
kind, a framework UI.

## 12. Order of work and done criteria

1. Generator and `data/` with the planted scenarios.
2. Ingest, cleaning log, `facts.db`, digest test.
3. Email extraction with evidence checks and cache; trust flags in code.
4. Detectors and ranking, with tests.
5. Calculators and the agent loop (fake API in tests first), plan checks with tests.
6. Actions, `work.db`, approvals and outbox, with guardrail tests.
7. HTTP server and UI.
8. Live runs recorded for each scenario; replay mode.
9. Evals, CI.
10. README and screenshots.

Done means: a fresh clone runs `npm install && npm start` and shows the full demo with no key;
`npm test` and `npm run eval:replay` pass; CI is green; the README reads well to someone who
has never seen the project.
