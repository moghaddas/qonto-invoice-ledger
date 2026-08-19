/**
 * End-to-end smoke test. Run `selfTest()` once from the editor, which also
 * triggers the one-time authorization. It is safe and idempotent:
 *   - synthesizes a throwaway PDF invoice, so no email is touched,
 *   - runs it through Gemini to prove extraction,
 *   - files it into Drive to prove foldering and naming, then trashes it,
 *   - reads the Qonto debit pool to prove API auth,
 *   - writes a row per step to a `SelfTest` tab in the ledger.
 * It never attaches to a real transaction and never archives mail.
 * Results are also visible in the execution log (View -> Logs).
 */
/** How far back the Qonto probe looks. Wide enough that a quiet account
 *  still returns a debit, which is what proves the credentials work. */
const SELFTEST_LOOKBACK_DAYS = 90;

function selfTest() {
  ensureLedger_(); // so the ledger + SelfTest tab exist even before setup()
  const out = { startedAt: new Date(), steps: [] };

  function step(name, fn) {
    try {
      const info = fn();
      out.steps.push({ name: name, ok: true, info: info });
      Logger.log('PASS %s: %s', name, info);
    } catch (e) {
      out.steps.push({ name: name, ok: false, info: String(e).slice(0, 400) });
      Logger.log('FAIL %s: %s', name, e);
    }
  }

  step('config', function () {
    const mode = prop_('CF_AIG_GATEWAY', false) ? 'ai-gateway' : 'direct-google';
    const hasGoogleKey = prop_('GEMINI_API_KEY', false) ? 'yes' : 'no(byok?)';
    const hasQonto = prop_('QONTO_SECRET_KEY', false) ? 'yes' : 'MISSING';
    const ownCompany = ownCompanyName_() ||
      'NOT SET - every document will file as a bill you owe, including your own outgoing invoices';
    return 'gemini=' + mode + ', googleKey=' + hasGoogleKey +
           ', qontoKey=' + hasQonto + ', accounts=' + qontoAccounts_().length +
           ', inbound=' + inboundFolderId_() + ', ownCompanyName=' + ownCompany;
  });

  let extracted = null;
  const sample = sampleInvoiceBlob_();

  step('gemini-extract', function () {
    extracted = geminiExtract_(sample.copyBlob());
    if (!extracted) throw new Error('null result (check CF_AIG_TOKEN / GEMINI_API_KEY / gateway auth)');
    if (!extracted.isInvoice) throw new Error('classified as non-invoice: ' + JSON.stringify(extracted));
    return 'supplier=' + extracted.supplier + ', date=' + extracted.invoiceDate +
           ', amount=' + extracted.amount + ' ' + extracted.currency +
           ', no=' + extracted.invoiceNumber + ', conf=' + extracted.confidence;
  });

  step('drive-file', function () {
    const supplier = 'SelfTest ' + ((extracted && extracted.supplier) || 'Vendor');
    const filed = fileInvoice_(sample.copyBlob(), supplier, new Date(), 'SELFTEST');
    DriveApp.getFileById(filed.id).setTrashed(true); // clean up immediately
    return 'filed+trashed ' + filed.name;
  });

  step('qonto-debits', function () {
    const to = new Date();
    const from = addDays_(to, -SELFTEST_LOOKBACK_DAYS);
    const debits = qontoDebits_(from, to);
    const free = debits.filter(function (t) { return !hasAttachment_(t); }).length;
    // Queued transfers come from a different endpoint and are not bounded by the
    // window above: a scheduled payment is dated in the future. A zero here while
    // Qonto shows a scheduled transfer means SCHEDULED can never be reached.
    const queued = qontoScheduledTransfers_();
    const next = queued.map(function (t) {
      return String(t.emitted_at).slice(0, 10) + ' ' + t.amount + ' ' + (t.label || t.reference);
    }).slice(0, 3).join('; ');
    return debits.length + ' debit(s) in last ' + SELFTEST_LOOKBACK_DAYS + 'd, ' +
           free + ' without a receipt, ' + queued.length + ' transfer(s) queued' +
           (next ? ': ' + next : '');
  });

  writeSelfTest_(out);
  const summary = out.steps.map(function (s) { return s.name + '=' + (s.ok ? 'PASS' : 'FAIL'); }).join(', ');
  Logger.log('SELFTEST COMPLETE: ' + summary);
  return summary;
}

/** Build a throwaway PDF invoice via Docs export (no external assets needed). */
function sampleInvoiceBlob_() {
  const doc = DocumentApp.create('selftest-invoice-tmp');
  const b = doc.getBody();
  b.appendParagraph('RECHNUNG / INVOICE');
  b.appendParagraph('Supplier: Acme Cloud GmbH');
  b.appendParagraph('Invoice number: SELFTEST-0001');
  b.appendParagraph('Invoice date: 2026-07-01');
  b.appendParagraph('Amount due (incl. VAT): EUR 123.45');
  b.appendParagraph('Bill to: ' + (ownCompanyName_() || 'Test Company'));
  doc.saveAndClose();
  const id = doc.getId();
  const pdf = DriveApp.getFileById(id).getAs('application/pdf').copyBlob();
  pdf.setName('selftest-invoice.pdf');
  DriveApp.getFileById(id).setTrashed(true);
  return pdf;
}

function writeSelfTest_(out) {
  const ss = SpreadsheetApp.openById(prop_('LEDGER_SHEET_ID', true));
  let sh = ss.getSheetByName('SelfTest');
  if (!sh) {
    sh = ss.insertSheet('SelfTest');
    sh.appendRow(['ranAt', 'step', 'ok', 'info']);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, 4).setFontWeight('bold');
  }
  out.steps.forEach(function (s) {
    sh.appendRow([out.startedAt, s.name, s.ok, String(s.info).slice(0, 500)]);
  });
}
