/**
 * Central configuration. Secrets and environment-specific IDs live in
 * Script Properties (Project Settings -> Script properties), never in code.
 * Run `setup()` once (Setup.gs) to scaffold the ledger and triggers.
 */

const CFG = {
  // --- Gmail ---
  // The script self-selects invoices with this search, so no manual labelling
  // and no Gmail filters. `newer_than:<GMAIL_LOOKBACK_DAYS>d` is appended to
  // bound the work; per-message dedupe and the isInvoice classifier keep it
  // correct and quiet. It runs against the AUTHORISING user's mailbox, so the
  // mail has to arrive there. Override with Script Property GMAIL_QUERY, and
  // add `to:billing@yourcompany.com` if invoices reach a shared address.
  GMAIL_QUERY_DEFAULT: 'has:attachment (invoice OR receipt OR rechnung OR beleg OR facture)',
  // A thread carries exactly one of these. It is the worst state among the
  // invoices filed from that thread, and the thread leaves the Inbox only once
  // every one of them is paid. LABEL_PREFIX puts them under a parent of your
  // choosing, so 'Finance/Invoices' nests them two deep.
  LABEL_PREFIX_DEFAULT: 'Invoices',
  THREAD_LABELS: {
    ERROR:     '⚠️ Error',
    REVIEW:    '🔎 Review',
    UNPAID:    '💸 Unpaid',
    SCHEDULED: '📅 Scheduled',
    PAID:      '✅ Paid'
  },
  // Worst first: the first state present on a thread is the one it shows.
  // SCHEDULED sits with PAID on the settled side, because the payment is
  // arranged and the mail can leave the Inbox. It ranks below UNPAID, so an
  // unarranged sibling still holds the thread there.
  THREAD_STATE_ORDER: ['ERROR', 'REVIEW', 'UNPAID', 'SCHEDULED', 'PAID'],
  // States whose threads belong out of the Inbox.
  THREAD_STATES_SETTLED: ['SCHEDULED', 'PAID'],
  // Gmail accepts only its own fixed palette here; any other hex is rejected
  // with a 400 naming the offending value.
  THREAD_LABEL_COLORS: {
    ERROR:     { backgroundColor: '#fb4c2f', textColor: '#ffffff' },
    REVIEW:    { backgroundColor: '#ffad47', textColor: '#000000' },
    UNPAID:    { backgroundColor: '#fad165', textColor: '#000000' },
    SCHEDULED: { backgroundColor: '#4a86e8', textColor: '#ffffff' },
    PAID:      { backgroundColor: '#16a766', textColor: '#ffffff' }
  },
  GMAIL_LOOKBACK_DAYS: 3,
  MAX_THREADS_PER_RUN: 50,

  // --- Drive (Inbound only; Outbound is out of scope) ---
  // Root "Inbound" folder the year subfolders sit under.
  // Path built underneath: <INBOUND>/<YYYY>/<YYMM>/<YYMMDD_Supplier.pdf>
  // Foldering is by INVOICE DATE, not payment date.
  // Set Script Property INBOUND_FOLDER_ID. There is deliberately no default:
  // a wrong folder id here writes invoices into somebody else's Drive.
  // Year folders may be named "2026" or "2026 Inbound Invoices", whichever
  // YEAR_FOLDER_SUFFIX makes. Month folders are "2607" (yyMM). The resolver
  // matches any existing folder holding the year or month token, so it reuses
  // the folders you already have instead of duplicating them.
  YEAR_FOLDER_SUFFIX: '',

  // --- Qonto ---
  QONTO_BASE_URL: 'https://thirdparty.qonto.com/v2',
  // Accounts to scan for matching debits: a comma-separated list of
  // bank_account_id in Script Property QONTO_ACCOUNT_IDS. Leave it unset to
  // scan every account the API key can read.

  // --- Gemini extraction ---
  GEMINI_MODEL: 'gemini-2.5-flash',
  GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/models',
  // Optional. Set CF_AIG_ACCOUNT_ID and CF_AIG_GATEWAY to route Gemini through
  // a Cloudflare AI Gateway, and CF_AIG_TOKEN too if that gateway is
  // authenticated. Calls go to the google-ai-studio PROVIDER endpoint, which
  // preserves the native Gemini contract including PDF inline_data and
  // responseSchema. Do not point this at a dynamic route: those force the
  // OpenAI-compatible schema, which mangles structured and PDF output.

  // --- Matching (conservative: only STRONG auto-attaches) ---
  MATCH_WINDOW_DAYS_BEFORE: 5,   // charge can predate the invoice slightly
  // Second pass, used only when the tight window holds no strong match: a
  // subscription is charged at the start of the period and invoiced at the end,
  // so its debit can predate the invoice by a month. Kept as a fallback rather
  // than a wider default because a vendor billing the same amount every month
  // puts last month's debit in range too, and two identical candidates resolve
  // to nothing.
  MATCH_WINDOW_DAYS_BEFORE_FALLBACK: 35,
  MATCH_WINDOW_DAYS_AFTER: 60,   // ...or settle well after it
  AMOUNT_TOLERANCE: 0.02,        // absolute, currency-agnostic; assumes a two-decimal minor unit
  NAME_MATCH_MIN: 0.34,          // token-overlap ratio to count as a name hit
  MAX_ATTEMPTS: 12,              // give up auto-matching after this many runs
  STALE_REVIEW_DAYS: 21,         // unmatched older than this -> flag in digest
  // Extraction failures are transient (rate limit, timeout, unreadable body).
  // The cap stops a document the model can never read from retrying for ever.
  MAX_EXTRACT_ATTEMPTS: 4,
  // How far back the digest lists not-an-invoice verdicts. One week matches the
  // digest interval, so each verdict is shown exactly once.
  DIGEST_SKIP_LOOKBACK_DAYS: 7,

  // --- Ledger sheet ---
  LEDGER_TAB: 'Ledger',
  SUPPLIERS_TAB: 'Suppliers',
  LEDGER_HEADERS: [
    'id', 'receivedAt', 'gmailMsgId', 'sender', 'supplier', 'supplierRaw',
    'invoiceDate', 'amount', 'currency', 'invoiceNumber', 'driveFileId',
    'driveFileName', 'status', 'qontoTxnId', 'qontoAccountId', 'attempts',
    'lastCheckedAt', 'notes', 'supplierIban'
  ],
  SUPPLIERS_HEADERS: ['matchType', 'pattern', 'canonicalName'] // matchType: domain|contains
};

const STATUS = {
  FILED: 'FILED',              // filed in Drive, awaiting a Qonto match
  SCHEDULED: 'SCHEDULED',      // matched to a transfer Qonto has not executed yet
  ATTACHED: 'ATTACHED',        // receipt attached to the transaction
  REVIEW: 'NEEDS_REVIEW',      // ambiguous or no confident match
  DUPLICATE: 'DUPLICATE',      // same supplier+date+amount+currency already filed
  ERROR: 'ERROR',
  // A model verdict, so it can be wrong: the digest lists these rows.
  NOT_INVOICE: 'SKIPPED_NOT_INVOICE',
  // Rule-decided (issued by you, outbound, self-billed). It cannot be wrong the
  // way a model verdict can, so the digest stays quiet about it.
  OUT_OF_SCOPE: 'SKIPPED_OUT_OF_SCOPE',
  // The call failed, carrying no verdict about the document. The row is retried.
  EXTRACT_FAILED: 'EXTRACT_FAILED'
};

/**
 * Ledger status -> Inbox thread state. A status absent here never labels a
 * thread: a duplicate or a non-invoice is ordinary mail and stays untouched.
 */
const THREAD_STATE_BY_STATUS = {};
THREAD_STATE_BY_STATUS[STATUS.ERROR] = 'ERROR';
THREAD_STATE_BY_STATUS[STATUS.EXTRACT_FAILED] = 'ERROR';
THREAD_STATE_BY_STATUS[STATUS.REVIEW] = 'REVIEW';
THREAD_STATE_BY_STATUS[STATUS.FILED] = 'UNPAID';
THREAD_STATE_BY_STATUS[STATUS.SCHEDULED] = 'SCHEDULED';
THREAD_STATE_BY_STATUS[STATUS.ATTACHED] = 'PAID';

function prop_(key, required) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (required && !v) throw new Error('Missing Script Property: ' + key);
  return v;
}

function qontoAccounts_() {
  const csv = prop_('QONTO_ACCOUNT_IDS', false);
  return csv ? csv.split(',').map(function (s) { return s.trim(); }).filter(String)
             : [];
}

/** Full Gmail label name for a state, under the configured parent. */
function labelName_(state) {
  const prefix = String(prop_('LABEL_PREFIX', false) || CFG.LABEL_PREFIX_DEFAULT)
    .replace(/^\/+|\/+$/g, '');
  return prefix + '/' + CFG.THREAD_LABELS[state];
}

function reviewEmail_() {
  return prop_('REVIEW_EMAIL', false) || Session.getEffectiveUser().getEmail();
}

/**
 * The timezone every date is formatted in. The ledger spreadsheet is created
 * in the user's own locale, so a date read back from a cell and a date string
 * written at capture only agree when both use the sheet's zone. They disagree
 * by a day otherwise, and content dedupe stops working.
 */
let TZ_CACHE = null;
function tz_() {
  if (TZ_CACHE) return TZ_CACHE;
  TZ_CACHE = SpreadsheetApp.openById(prop_('LEDGER_SHEET_ID', true))
    .getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  return TZ_CACHE;
}

function inboundFolderId_() {
  return prop_('INBOUND_FOLDER_ID', true);
}

function gmailQuery_() {
  return prop_('GMAIL_QUERY', false) || CFG.GMAIL_QUERY_DEFAULT;
}

/** Override with Script Property GEMINI_MODEL to switch models without a code push. */
function geminiModel_() {
  return prop_('GEMINI_MODEL', false) || CFG.GEMINI_MODEL;
}

/**
 * Your own company name, used to tell an invoice you received from one you
 * issued. Set OWN_COMPANY_NAME; without it every document counts as inbound.
 */
function ownCompanyName_() {
  return String(prop_('OWN_COMPANY_NAME', false) || '').trim();
}

/**
 * Whether this run may touch anything outside Drive and the ledger.
 *
 * An absent property means a fresh install nobody has reviewed yet, so the
 * safe answer is the default. A dry run still files to Drive and fills the
 * ledger, which is how you read what it decided. It does not attach anything
 * to a bank transaction and does not relabel or archive any mail.
 */
function dryRun_() {
  const v = PropertiesService.getScriptProperties().getProperty('DRY_RUN');
  return v === null || String(v).trim().toLowerCase() === 'true';
}
