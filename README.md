# qonto-invoice-ledger

Supplier invoices arrive as email attachments and have to end up in three
places: a folder your accountant can read, a list you can audit, and against
the right line on your bank statement. This does all three from Gmail, on a
schedule, in Google Apps Script. The bank is **Qonto**, and it is the only one
implemented.

```
Gmail search  ->  Gemini extract  ->  Drive archive  ->  Sheet ledger  ->  Qonto match
```

## What this adds to Qonto

**Qonto already matches receipts to transactions.** Forward an invoice to your
dedicated Qonto address and its OCR pairs it with an outgoing payment. If that
is enough, use it, it is free and there is nothing to run.

What that leaves out:

- **Your own archive.** Files land in Drive as `2026/2607/260715_Supplier.pdf`,
  named by invoice date, under a canonical supplier name you control. An
  existing year folder is reused whatever you called it, so `2026 Invoices` is
  picked up rather than duplicated. The accountant gets a folder, not an export.
- **A ledger you can audit.** One row per invoice in a Google Sheet: the
  extracted fields, the status, the matched transaction, and a note on every
  decision the matcher made.
- **A matcher you can read.** Amount and currency have to agree exactly. Only
  one unambiguous candidate attaches by itself. Everything else waits, then
  lands in a Monday digest.
- **Scheduled payments.** Money committed but not moved is its own state. Qonto
  has no transaction for a queued transfer, so this reads `/sepa/transfers` as
  a second source and marks the invoice arranged.
- **Inbox state.** A thread carries one label, the worst state among the
  invoices filed from it, and leaves the Inbox once they are all settled. State
  comes from the ledger, not the label, so a hand edit is corrected on the next
  run.

`Qonto.js` is the whole adapter.

## Dry run

**A fresh install starts in dry run and stays there until you turn it off.**

In dry run the pipeline runs end to end. Invoices are extracted, filed to
Drive, and written to the ledger, so you can read what it decided. It does not
attach anything to a bank transaction, create or apply a Gmail label, archive
or move mail, or send the digest. The ledger notes say what it would have
attached, and the execution log carries the rest.

`attachManually()` refuses outright while it is on, rather than reporting a
success it never performed.

Read the ledger, then set the `DRY_RUN` property to `false`.

## Install

You need a Google account, a Gemini API key from
[AI Studio](https://aistudio.google.com/apikey), and a Qonto API key.

1. Open the shared Apps Script project and choose **File > Make a copy**,
   which puts the whole project in your own Drive with your own trigger and
   Script Property scope:

   <https://script.google.com/d/1IL0jBeggRfv1eJDNwck-vdNcFEwKWWoyciPRLTIVTSTFhs9CXy2Y4seK/edit>

   Sign in to Google first. The link opens the project read-only, and the
   copy is yours to edit. Apps Script has no direct copy URL, so the copy
   happens inside the editor.

   Or copy the files from `src/` by hand into a new standalone Apps Script
   project. Either way, the account you copy into is the account that ends up
   holding your Gemini key, your Qonto key, and your Drive archive: nothing
   here can set those up for you.

2. Create a Drive folder for the archive and copy its id out of the URL.

3. In **Project Settings -> Script properties**, add:

   | Property | | |
   |---|---|---|
   | `INBOUND_FOLDER_ID` | required | Drive folder the archive is built in |
   | `QONTO_SECRET_KEY` | required | Qonto API key |
   | `GEMINI_API_KEY` | required | AI Studio key |
   | `OWN_COMPANY_NAME` | strongly advised | Tells an invoice you received from one you issued |
   | `QONTO_LOGIN` | if your key is a `login:secret` pair | |
   | `QONTO_ACCOUNT_IDS` | optional | Accounts to scan, comma separated. Unset scans every one the key can read |
   | `GMAIL_QUERY` | optional | Overrides the search, add `to:billing@yourcompany.com` for a shared address |
   | `GEMINI_MODEL` | optional | Overrides the extraction model, default `gemini-2.5-flash` |
   | `REVIEW_EMAIL` | optional | Digest recipient, defaults to you |
   | `LABEL_PREFIX` | optional | Gmail parent for the state labels, default `Invoices` |
   | `DRY_RUN` | set by `setup()` | `true` until you decide otherwise |
   | `LEDGER_SHEET_ID` | set for you | The ledger, created on the first run |
   | `CF_AIG_ACCOUNT_ID`, `CF_AIG_GATEWAY`, `CF_AIG_TOKEN` | optional | Route Gemini through a Cloudflare AI Gateway |

4. Run `selfTest()` from the editor. It authorises the scopes, then proves
   extraction, filing, and Qonto auth by pushing a throwaway invoice through
   the whole path and trashing it. No real mail is touched.

5. Run `setup()`. It creates the ledger and the Gmail labels, then installs the
   triggers: capture every 10 minutes, reconcile every 4 hours, digest on
   Monday morning.

6. Let it run, read the ledger, then turn `DRY_RUN` off.

## How matching works

A candidate has to agree on amount and currency, against either the account
figure or the original one on a foreign-currency charge. That alone is never
enough. A **strong** match also needs one of:

- the supplier name inside the transaction label, reference, note, or
  counterparty name, above a token-overlap threshold
- the invoice number inside the payment reference
- the vendor IBAN equal to the transfer counterparty, the strongest signal

Exactly one strong match with no receipt on it attaches. If that transaction
already carries a receipt, the row links to it without uploading a second copy,
which is how an invoice you reconciled by hand in Qonto closes. Two candidates
settle nothing and go to review.

The search runs from 5 days before the invoice to 60 days after. A subscription
charged at the start of a period and invoiced at the end sits outside that, so
a tight window holding no strong match widens to 35 days before. The wider span
is a fallback rather than the default: a vendor billing the same amount every
month puts last month's debit in range too, and two identical candidates
resolve to nothing.

## Dates

Every date is formatted in the ledger spreadsheet's own timezone, which it
inherits from your Google account. That decides the folder an invoice files
into and the day its fingerprint carries, so set the sheet's zone before you
file anything.

## What it costs

One Gemini 2.5 Flash call per attachment, sent as raw file bytes with a
response schema. Apps Script, Drive, Sheets and Gmail are free at this volume.
A few hundred invoices a month is cents.

## Limits

- **Qonto only.** Another bank means another `Qonto.js`. The interface it has
  to satisfy is small: list debits in a date range, list queued transfers, get
  one transaction, attach a file.
- **It reads the authorising user's mailbox.** An invoice sent to a shared
  address has to land there, through delivery or forwarding. A group alias
  nobody receives is invisible.
- **Extraction is a model, not a parser.** The ledger flags a low-confidence
  read and the digest catches what did not match, but a wrong amount taken off
  an unusual layout will never find its debit.
- **50 threads a run, 3 days back.** Both are constants in `Config.js` rather
  than properties. The defaults suit a steady flow, not a first-time import of
  a full archive.
- **One currency per invoice.** A document billing in two currencies extracts
  one of them.

## Maintainer

This section covers keeping the canonical shared Apps Script project in sync
with `src/`. It is not part of the user install above.

```
npm install
cp .clasp.json.example .clasp.json   # fill in the real scriptId
npx clasp login                      # one-time, opens a Google OAuth prompt
npm run push
```

`clasp login` needs the Apps Script API enabled on the maintainer's own
Google account (script.google.com -> Settings -> Google Apps Script API).
This is a manual, one-time step in the Google account settings UI; no script
or CLI flag can turn it on from outside. `.clasp.json` holds the real
`scriptId` and stays out of git; only `.clasp.json.example` is committed.

## License

MIT. See [LICENSE](LICENSE).
