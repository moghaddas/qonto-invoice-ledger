# gmail-invoice-ledger

Supplier invoices arrive as email attachments and have to end up in three
places: a folder your accountant can read, a list you can audit, and against
the right line on your bank statement. This does all three from Gmail, on a
schedule, in Google Apps Script.

```
Gmail search  ->  Gemini extract  ->  Drive archive  ->  Sheet ledger  ->  bank match
```

## Read this before you install it

**Qonto already matches receipts to transactions.** Forward an invoice to your
dedicated Qonto address and its OCR pairs it with an outgoing payment. If that
is all you need, use it, it is free and there is nothing to run.

This is for what that leaves out:

- **Your own archive.** Files land in your Drive as
  `2026 Invoices/2607/260715_Supplier.pdf`, named by invoice date, under a
  canonical supplier name you control. Your accountant gets a folder, not an
  export.
- **A ledger you can audit.** One row per invoice in a Google Sheet, with the
  extracted fields, the status, the matched transaction, and a note explaining
  every decision the matcher made.
- **A matcher you can read.** Amount and currency must agree exactly. Only a
  single unambiguous match attaches by itself. Everything else waits, then
  lands in a Monday digest. Nothing is a black box.
- **Scheduled payments.** Money committed but not yet moved is its own state.
  Qonto has no transaction for a queued transfer, so this reads
  `/sepa/transfers` as a second source and marks the invoice arranged.
- **Inbox state.** A thread carries one label, the worst state among the
  invoices filed from it, and leaves the Inbox once they are all settled.
  Labels are derived from the ledger, so editing one by hand is corrected on
  the next run.

Qonto is the one bank implemented. `Qonto.js` is the whole adapter.

## Dry run

**A fresh install starts in dry run and stays there until you turn it off.**

In dry run the pipeline runs end to end. Invoices are extracted, filed to
Drive, and written to the ledger, so you can read exactly what it decided.
What it will not do is attach anything to a bank transaction or relabel,
archive, or move any mail. The ledger notes say what it would have attached.

Read the ledger, then set the `DRY_RUN` property to `false`.

## Install

You need a Google account, a Gemini API key from
[AI Studio](https://aistudio.google.com/apikey), and a Qonto API key.

1. Create a new Apps Script project and copy the files from `src/` into it,
   or push them with [clasp](https://github.com/google/clasp):

   ```
   npm i -g @google/clasp
   clasp login
   clasp create --type standalone --title "Invoice ledger" --rootDir src
   clasp push
   ```

2. Create a Drive folder for the archive and copy its id out of the URL.

3. In **Project Settings -> Script properties**, add:

   | Property | | |
   |---|---|---|
   | `INBOUND_FOLDER_ID` | required | Drive folder the archive is built in |
   | `QONTO_SECRET_KEY` | required | Qonto API key |
   | `GEMINI_API_KEY` | required | AI Studio key |
   | `OWN_COMPANY_NAME` | strongly advised | Tells an invoice you received from one you issued |
   | `QONTO_LOGIN` | if your key is a `login:secret` pair | |
   | `QONTO_ACCOUNT_IDS` | optional | Accounts to scan, comma separated. Unset scans all of them |
   | `GMAIL_QUERY` | optional | Overrides the search, add `to:billing@yourcompany.com` for a shared address |
   | `REVIEW_EMAIL` | optional | Digest recipient, defaults to you |
   | `DRY_RUN` | set by `setup()` | `true` until you decide otherwise |
   | `LEDGER_SHEET_ID` | set by `setup()` | Created for you |
   | `CF_AIG_ACCOUNT_ID`, `CF_AIG_GATEWAY`, `CF_AIG_TOKEN` | optional | Route Gemini through a Cloudflare AI Gateway |

4. Run `selfTest()` from the editor. It authorises the scopes, then proves
   extraction, filing, and Qonto auth by pushing a throwaway invoice through
   the whole path and trashing it afterwards. No real mail is touched.

5. Run `setup()`. It creates the ledger, creates the Gmail labels, and installs
   the triggers: capture every 10 minutes, reconcile every 4 hours, digest on
   Monday morning.

6. Let it run, read the ledger, then turn `DRY_RUN` off.

## How matching works

A candidate has to agree on amount and currency, against either the account
amount or the original amount on a foreign-currency charge. That alone is
never enough. A **strong** match also needs one of:

- the supplier name inside the transaction label, reference, note, or
  counterparty name, above a token-overlap threshold
- the invoice number inside the payment reference
- the vendor IBAN equal to the transfer counterparty, the strongest signal

Exactly one strong match with no receipt on it attaches. One strong match that
already has a receipt is linked without uploading a second copy, which is how
an invoice you reconciled by hand in Qonto settles. Two candidates settle
nothing and go to review.

The search window runs from 5 days before the invoice to 60 days after. A
subscription charged at the start of a period and invoiced at the end can fall
outside that, so an empty window is retried at 35 days before. The wider window
is a fallback rather than the default because a vendor billing the same amount
every month puts last month's debit in range too, and two identical candidates
resolve to nothing.

## What it costs

One Gemini 2.5 Flash call per attachment, sent as raw PDF bytes with a response
schema. Apps Script, Drive, Sheets and Gmail are free at this volume. A few
hundred invoices a month is cents.

## Limits

- **Qonto only.** Another bank means another `Qonto.js`. The interface it has
  to satisfy is small: list debits in a date range, list queued transfers, get
  one transaction, attach a file.
- **It reads the authorising user's mailbox.** Invoices sent to a shared
  address have to actually arrive in that mailbox, through delivery or
  forwarding. A group alias nobody receives is invisible to it.
- **Extraction is a model, not a parser.** The ledger carries the model's own
  confidence, and the digest catches what did not match, but a wrong amount
  read off an unusual layout will simply fail to find its debit.
- **50 threads a run, 3 days back.** Both are configurable. The defaults suit
  a steady flow, not a first-time import of a full archive.
- **One currency per invoice.** A document billing in two currencies extracts
  one of them.

## License

MIT. See [LICENSE](LICENSE).
