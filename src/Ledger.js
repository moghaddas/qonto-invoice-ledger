/**
 * Google Sheet as durable state. Column access is header-based so the tab can
 * be reordered without breaking the code.
 */

function ledgerSheet_() {
  return SpreadsheetApp.openById(prop_('LEDGER_SHEET_ID', true)).getSheetByName(CFG.LEDGER_TAB);
}

function colIndex_(headers, name) {
  const i = headers.indexOf(name);
  if (i < 0) throw new Error('Ledger column not found: ' + name);
  return i;
}

function ledgerReadAll_() {
  const sh = ledgerSheet_();
  const values = sh.getDataRange().getValues();
  const headers = values.shift();
  return { sh: sh, headers: headers, rows: values };
}

/**
 * Content fingerprint for dedupe — stable across re-captures and Drive lag.
 * The invoice number is the vendor's own identifier for the document, so it
 * wins whenever there is one: extraction names the same vendor inconsistently
 * ("Powerplay GmbH" vs "Powerplay GmbH (Cello)"), and a supplier-keyed
 * fingerprint files one invoice twice on nothing but that wording.
 */
function fpKey_(supplier, invoiceDate, amount, currency, invoiceNumber) {
  const amt = (Number(amount) || 0).toFixed(2);
  const cur = String(currency || '').toUpperCase().trim();
  const inv = String(invoiceNumber || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // The date stays in the key even with a number present: some vendors repeat a
  // number across months (ElevenLabs bills AAMN7HEH-0005 in June and again in
  // July), and a number-only key would merge two real invoices into one.
  const head = inv.length >= 4 ? ['no', inv] : ['su', String(supplier || '').toLowerCase().trim()];
  return head.concat([fpDate_(invoiceDate), amt, cur]).join('|');
}

/**
 * The invoiceDate column holds a real date cell, so a ledger read yields a Date
 * while capture passes the 'yyyy-MM-dd' string it just built. Both must land on
 * the same key or cross-run dedupe silently compares two different key spaces
 * and every re-send is filed as a new invoice.
 */
function fpDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Europe/Berlin', 'yyyy-MM-dd');
  return String(v || '').trim().slice(0, 10);
}

/** Set of fingerprints for already-filed invoices (FILED/ATTACHED/REVIEW). */
function contentFingerprints_() {
  const { headers, rows } = ledgerReadAll_();
  const si = colIndex_(headers, 'status'), su = colIndex_(headers, 'supplier');
  const da = colIndex_(headers, 'invoiceDate'), am = colIndex_(headers, 'amount'), cu = colIndex_(headers, 'currency');
  const no = colIndex_(headers, 'invoiceNumber');
  const fps = {};
  rows.forEach(function (r) {
    const st = String(r[si]);
    if (st === STATUS.FILED || st === STATUS.ATTACHED || st === STATUS.REVIEW ||
        st === STATUS.SCHEDULED) {
      fps[fpKey_(r[su], r[da], r[am], r[cu], r[no])] = true;
    }
  });
  return fps;
}

/** Map of every Gmail message id already recorded, read once per capture run. */
function seenMessageIds_() {
  const { headers, rows } = ledgerReadAll_();
  const c = colIndex_(headers, 'gmailMsgId');
  const seen = {};
  rows.forEach(function (r) { if (r[c]) seen[String(r[c])] = true; });
  return seen;
}

/**
 * Map of gmailMsgId -> the Inbox states its ledger rows carry. One message can
 * hold several attachments, so a message can be in more than one state at once.
 */
function ledgerThreadStates_() {
  const { headers, rows } = ledgerReadAll_();
  const mi = colIndex_(headers, 'gmailMsgId'), si = colIndex_(headers, 'status');
  const su = colIndex_(headers, 'supplier'), da = colIndex_(headers, 'invoiceDate');
  const am = colIndex_(headers, 'amount'), cu = colIndex_(headers, 'currency');
  const no = colIndex_(headers, 'invoiceNumber');

  // A duplicate has no state of its own — it is one invoice arriving twice, so
  // it inherits from the copy that was filed. A supplier that sends the same
  // receipt on two messages otherwise pins its thread in the Inbox: the filed
  // copy archives, the duplicate does not, and the thread shows both.
  // The fingerprint names one real invoice, so the MOST settled copy wins: once
  // any copy reaches a completed debit, that invoice is paid. A copy left
  // unmatched keeps its own thread in the Inbox on its own row, so taking the
  // settled state here hides nothing.
  const stateByFp = {};
  rows.forEach(function (r) {
    const state = THREAD_STATE_BY_STATUS[String(r[si])];
    if (!state) return;
    const fp = fpKey_(r[su], r[da], r[am], r[cu], r[no]);
    const known = stateByFp[fp];
    if (!known || CFG.THREAD_STATE_ORDER.indexOf(state) > CFG.THREAD_STATE_ORDER.indexOf(known)) {
      stateByFp[fp] = state;
    }
  });

  const out = {};
  rows.forEach(function (r) {
    const msgId = String(r[mi] || '');
    if (!msgId) return;
    const status = String(r[si]);
    const state = THREAD_STATE_BY_STATUS[status] ||
      (status === STATUS.DUPLICATE ? stateByFp[fpKey_(r[su], r[da], r[am], r[cu], r[no])] : null);
    if (!state) return;
    if (!out[msgId]) out[msgId] = [];
    if (out[msgId].indexOf(state) < 0) out[msgId].push(state);
  });
  return out;
}

function ledgerAppend_(record) {
  const sh = ledgerSheet_();
  const row = CFG.LEDGER_HEADERS.map(function (h) {
    return record[h] === undefined || record[h] === null ? '' : record[h];
  });
  sh.appendRow(row);
}

/** Returns [{rowNumber, obj}] for rows whose status is in `statuses`. */
function ledgerFindByStatus_(statuses) {
  const { headers, rows } = ledgerReadAll_();
  const sc = colIndex_(headers, 'status');
  const out = [];
  rows.forEach(function (r, i) {
    if (statuses.indexOf(String(r[sc])) >= 0) {
      out.push({ rowNumber: i + 2, obj: rowToObj_(headers, r) });
    }
  });
  return out;
}

function rowToObj_(headers, r) {
  const o = {};
  headers.forEach(function (h, i) { o[h] = r[i]; });
  return o;
}

/** Patch specific columns on a 1-based sheet row. */
function ledgerUpdate_(rowNumber, patch) {
  const sh = ledgerSheet_();
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Object.keys(patch).forEach(function (k) {
    const c = headers.indexOf(k);
    if (c >= 0) sh.getRange(rowNumber, c + 1).setValue(patch[k]);
  });
}
