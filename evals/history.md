# Eval history

Each live recording of the eval cases, what it showed, and what changed before the next one.
`results.md` always shows the latest.

## Run 1: 2026-11-06, 10 of 11 pass

`claude-sonnet-5-5` through Claude Code, medium effort. About $0.03–0.06 (estimated) and 15–26 s per run.

- **Failed: overlay_buyer_confirms_price.** The buyer confirmed the higher price in writing, but the
  agent short-paid the matched $8,172 and left $435 unpaid. Cause: nothing told the model that a
  short pay sends the vendor a remittance advice showing the withheld amount, so it is a dispute
  the vendor sees. Holding the invoice was the quieter option.
- **Passed, but too loosely: duplicate_invoice.** The agent held both copies, so the real invoice
  could never be paid. The prompt and checks blocked paying any invoice in a duplicate issue, and
  the case accepted a hold on either one.

### What changed after run 1

- `short_pay` and its document now say the vendor receives a remittance advice showing the
  withheld amount; `hold_payment` says nothing is sent. The overlay case is unchanged.
- A duplicate issue names one kept original (already paid or approved, else the earliest invoice)
  and the copies. Only copies are blocked from payment. The case now requires a hold on the copy
  and forbids holding the original.
- `read_email` says who sent the email (internal, known vendor or unknown) and no longer calls a
  colleague's email "vendor content".

## Run 2: not recorded yet

Every case is re-recorded with the changes above.
