/**
 * Weekly review digest + a manual-resolve helper for the ambiguous tail.
 */

function runDigest() {
  const review = ledgerFindByStatus_([STATUS.REVIEW, STATUS.ERROR, STATUS.EXTRACT_FAILED]);
  const stillFiled = ledgerFindByStatus_([STATUS.FILED]).filter(function (i) {
    return i.obj.invoiceDate && daysSince_(new Date(i.obj.invoiceDate), new Date()) > CFG.STALE_REVIEW_DAYS;
  });
  const items = review.concat(stillFiled);
  const skipped = recentClassifierSkips_();
  if (!items.length && !skipped.length) return;

  const sheetUrl = SpreadsheetApp.openById(prop_('LEDGER_SHEET_ID', true)).getUrl();
  let html = '';
  if (items.length) {
    html += '<p>' + items.length + ' invoice(s) need attention. Open the ledger to resolve:</p>' +
      '<p><a href="' + sheetUrl + '">Invoice Ledger</a></p>' + digestTable_(items);
  }
  if (skipped.length) {
    html += '<p>' + skipped.length + ' document(s) in the last ' + CFG.DIGEST_SKIP_LOOKBACK_DAYS +
      ' days were judged not to be invoices. No other part of the pipeline shows these rows, ' +
      'so scan them for a wrong verdict:</p>' + digestTable_(skipped);
  }
  html += '<p style="color:#666">To pin a row to a transaction, run ' +
    '<code>attachManually(rowNumber, transactionId)</code>. To send a row back through ' +
    'extraction, run <code>reprocessRow(rowNumber)</code>. To file a document the extraction ' +
    'refuses, run <code>fileManually(rowNumber, {supplier, invoiceDate, amount, currency, invoiceNumber})</code>.</p>';

  MailApp.sendEmail({
    to: reviewEmail_(),
    subject: 'Invoice reconciliation – ' + items.length + ' to review, ' + skipped.length + ' skipped',
    htmlBody: html
  });
}

/**
 * Documents the extraction judged not to be invoices, inside the digest window.
 * A wrong verdict here drops an invoice silently: the row carries no thread
 * label and no other report lists it. OUT_OF_SCOPE rows are left out because a
 * rule decides those, not a judgement.
 * @return {Array<{rowNumber: number, obj: Object}>}
 */
function recentClassifierSkips_() {
  return ledgerFindByStatus_([STATUS.NOT_INVOICE]).filter(function (i) {
    const t = i.obj.receivedAt;
    return t && daysSince_(new Date(t), new Date()) <= CFG.DIGEST_SKIP_LOOKBACK_DAYS;
  });
}

function digestTable_(items) {
  let html = '<table border="1" cellpadding="6" cellspacing="0">' +
    '<tr><th>Row</th><th>Supplier</th><th>Date</th><th>Amount</th><th>Status</th><th>Document</th><th>Notes</th></tr>';
  items.forEach(function (i) {
    const o = i.obj;
    html += '<tr><td>' + i.rowNumber + '</td><td>' + esc_(o.supplier || o.supplierRaw) +
      '</td><td>' + esc_(o.invoiceDate) + '</td><td>' + esc_(o.amount) + ' ' + esc_(o.currency) +
      '</td><td>' + esc_(o.status) + '</td><td>' + esc_(o.driveFileName) +
      '</td><td>' + esc_(o.notes) + '</td></tr>';
  });
  return html + '</table>';
}

/**
 * Manually pin an invoice to a transaction and attach it. Use for the rows the
 * automatic matcher left in NEEDS_REVIEW.
 */
function attachManually(rowNumber, transactionId) {
  // Refuse rather than preview. This one is typed by hand to make something
  // happen, so reporting success while attaching nothing is the worst answer.
  if (dryRun_()) throw new Error('DRY_RUN is on. Set it to false to attach.');
  const sh = ledgerSheet_();
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const inv = rowToObj_(headers, sh.getRange(rowNumber, 1, 1, headers.length).getValues()[0]);
  const txn = qontoGetTransaction_(transactionId);
  attachAndMark_(rowNumber, inv, txn);
  syncThreads_([inv.gmailMsgId]);
  Logger.log('Attached row %s to %s', rowNumber, transactionId);
}

/**
 * Send one row back through extraction and rewrite it with the new verdict.
 * Use on a row the extraction judged wrongly, or one that reached
 * MAX_EXTRACT_ATTEMPTS. Run from the editor.
 *
 * Do not run it on a FILED or ATTACHED row: the row's own fingerprint is
 * already in the dedupe set, so the document comes back as a DUPLICATE of
 * itself and the Drive file it points at is orphaned.
 * @return {string} the new status
 */
function reprocessRow(rowNumber) {
  const sh = ledgerSheet_();
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const o = rowToObj_(headers, sh.getRange(rowNumber, 1, 1, headers.length).getValues()[0]);

  const att = messageAttachment_(String(o.gmailMsgId), String(o.driveFileName || ''));
  if (!att) throw new Error('No matching attachment on message ' + o.gmailMsgId);

  const patch = classifyAttachment_(o.sender, att, geminiExtract_(att.copyBlob()), contentFingerprints_());
  patch.lastCheckedAt = new Date();
  ledgerUpdate_(rowNumber, patch);
  syncThreads_([String(o.gmailMsgId)]);
  Logger.log('Row %s reprocessed -> %s', rowNumber, patch.status);
  return patch.status;
}

/**
 * File a row's attachment with metadata given by hand, and leave the row FILED
 * so the next reconcile matches it against a debit. This is the escape hatch
 * for a document the extraction will not accept as an invoice; it skips both
 * the classifier and the content-dedupe check.
 *
 * fileManually(42, {supplier: 'Acme', invoiceDate: '2026-08-20',
 *                   amount: 456, currency: 'EUR', invoiceNumber: 'INV-1'})
 * @return {string} the Drive file name
 */
function fileManually(rowNumber, meta) {
  const sh = ledgerSheet_();
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const o = rowToObj_(headers, sh.getRange(rowNumber, 1, 1, headers.length).getValues()[0]);

  const supplier = meta.supplier || o.supplier || o.supplierRaw;
  const invoiceDate = normalizeDate_(meta.invoiceDate);
  if (!supplier) throw new Error('fileManually needs a supplier');
  if (!invoiceDate) throw new Error('fileManually needs invoiceDate as YYYY-MM-DD');

  const att = messageAttachment_(String(o.gmailMsgId), String(o.driveFileName || ''));
  if (!att) throw new Error('No matching attachment on message ' + o.gmailMsgId);

  const filed = fileInvoice_(att.copyBlob(), supplier, invoiceDate, meta.invoiceNumber);
  ledgerUpdate_(rowNumber, {
    supplier: supplier,
    supplierRaw: o.supplierRaw || supplier,
    invoiceDate: Utilities.formatDate(invoiceDate, tz_(), 'yyyy-MM-dd'),
    amount: Number(meta.amount) || 0,
    currency: String(meta.currency || 'EUR').toUpperCase(),
    invoiceNumber: meta.invoiceNumber || '',
    driveFileId: filed.id,
    driveFileName: filed.name,
    status: STATUS.FILED,
    attempts: 0,
    lastCheckedAt: '',
    notes: 'filed manually',
    supplierIban: (meta.supplierIban || '').replace(/\s+/g, '')
  });
  syncThreads_([String(o.gmailMsgId)]);
  Logger.log('Row %s filed manually as %s', rowNumber, filed.name);
  return filed.name;
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
