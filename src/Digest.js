/**
 * Weekly review digest + a manual-resolve helper for the ambiguous tail.
 */

function runDigest() {
  const review = ledgerFindByStatus_([STATUS.REVIEW, STATUS.ERROR]);
  const stillFiled = ledgerFindByStatus_([STATUS.FILED]).filter(function (i) {
    return i.obj.invoiceDate && daysBetween_(new Date(i.obj.invoiceDate), new Date()) > CFG.STALE_REVIEW_DAYS;
  });
  const items = review.concat(stillFiled);
  if (!items.length) return;

  const sheetUrl = SpreadsheetApp.openById(prop_('LEDGER_SHEET_ID', true)).getUrl();
  let html = '<p>' + items.length + ' invoice(s) need attention. Open the ledger to resolve:</p>' +
    '<p><a href="' + sheetUrl + '">Invoice Ledger</a></p><table border="1" cellpadding="6" cellspacing="0">' +
    '<tr><th>Row</th><th>Supplier</th><th>Date</th><th>Amount</th><th>Status</th><th>Notes</th></tr>';
  items.forEach(function (i) {
    const o = i.obj;
    html += '<tr><td>' + i.rowNumber + '</td><td>' + esc_(o.supplier) + '</td><td>' + esc_(o.invoiceDate) +
      '</td><td>' + esc_(o.amount) + ' ' + esc_(o.currency) + '</td><td>' + esc_(o.status) +
      '</td><td>' + esc_(o.notes) + '</td></tr>';
  });
  html += '</table><p style="color:#666">To resolve a row manually, put the Qonto transaction id in the ' +
    'ledger and run <code>attachManually(rowNumber, transactionId)</code>.</p>';

  MailApp.sendEmail({
    to: reviewEmail_(),
    subject: 'Invoice reconciliation – ' + items.length + ' to review',
    htmlBody: html
  });
}

/**
 * Manually pin an invoice to a transaction and attach it. Use for the rows the
 * automatic matcher left in NEEDS_REVIEW.
 */
function attachManually(rowNumber, transactionId) {
  const sh = ledgerSheet_();
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const inv = rowToObj_(headers, sh.getRange(rowNumber, 1, 1, headers.length).getValues()[0]);
  const txn = qontoGetTransaction_(transactionId);
  attachAndMark_(rowNumber, inv, txn);
  syncThreads_([inv.gmailMsgId]);
  Logger.log('Attached row %s to %s', rowNumber, transactionId);
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
