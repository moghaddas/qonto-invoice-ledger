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

  // Matching runs against live bank data, so these cases are the only place the
  // scoring rules are pinned: an FX band that stands alone, or a tiebreak that
  // guesses between two close charges, attaches a receipt to the wrong payment.
  step('match-scoring', function () {
    const txn = function (label, amount, currency, localAmount, localCurrency, emitted) {
      return {
        label: label, amount: amount, currency: currency,
        local_amount: localAmount, local_currency: localCurrency,
        emitted_at: emitted, reference: '', note: null, clean_counterparty_name: label
      };
    };
    const score = function (inv, t) { return { t: t, score: scoreMatch_(inv, t) }; };
    const expect = function (name, cond) { if (!cond) throw new Error(name); };

    // A vendor billing in USD, settled in EUR, with the USD original preserved.
    const el = { supplier: 'Eleven Labs Inc.', supplierRaw: 'Eleven Labs Inc.', amount: 1600, currency: 'USD' };
    const elc = [
      score(el, txn('ELEVENLABS.IO', 1404.74, 'EUR', 1600, 'USD', '2026-06-13')),
      score(el, txn('ELEVENLABS.IO', 1387.56, 'EUR', 1600, 'USD', '2026-07-12')),
      score(el, txn('ELEVENLABS.IO', 1365.19, 'EUR', 1600, 'USD', '2026-05-12'))
    ];
    expect('local_amount should match exactly', elc.every(function (c) { return c.score.amountExact && c.score.strong; }));
    expect('tiebreak should take the nearest charge',
      nearestByDate_(elc, new Date('2026-06-12')).t.amount === 1404.74);

    // The card network converted first, so no amount is in the invoice currency.
    const gr = { supplier: 'Granola', supplierRaw: 'Granola', amount: 14, currency: 'USD' };
    const grc = [
      score(gr, txn('GRANOLA INC', 12.45, 'EUR', 12.45, 'EUR', '2026-07-21')),
      score(gr, txn('GRANOLA INC', 12.73, 'EUR', 12.73, 'EUR', '2026-06-21')),
      score(gr, txn('GRANOLA INC', 12.69, 'EUR', 12.69, 'EUR', '2026-08-21'))
    ];
    expect('converted band should match', grc.every(function (c) {
      return !c.score.amountExact && c.score.amountConverted && c.score.strong;
    }));
    expect('tiebreak should take the nearest converted charge',
      nearestByDate_(grc, new Date('2026-07-20')).t.amount === 12.45);

    // A different vendor whose amount collides inside AMOUNT_TOLERANCE.
    const ins = { supplier: 'Instantly', supplierRaw: 'Instantly', amount: 49.99, currency: 'USD' };
    const collide = scoreMatch_(ins, txn('TWILIO.COM', 42.7, 'EUR', 50.01, 'USD', '2026-06-01'));
    expect('colliding amount still matches', collide.amountExact);
    expect('but the name gate must reject it', !collide.strong);

    expect('the band must not stand alone',
      !scoreMatch_(gr, txn('SOME RANDOM SHOP', 12.5, 'EUR', 12.5, 'EUR', '2026-07-21')).amountOk);
    expect('the band must not fire on a comparable currency',
      !scoreMatch_({ supplier: 'Granola', supplierRaw: 'Granola', amount: 14, currency: 'EUR' },
                   txn('GRANOLA INC', 12.45, 'EUR', 12.45, 'EUR', '2026-07-21')).amountOk);
    expect('two close charges must not auto-pick', nearestByDate_([
      score(gr, txn('GRANOLA INC', 12.45, 'EUR', 12.45, 'EUR', '2026-07-21')),
      score(gr, txn('GRANOLA INC', 12.50, 'EUR', 12.50, 'EUR', '2026-07-26'))
    ], new Date('2026-07-20')) === null);

    return '9 cases';
  });

  // A PDF sent as application/octet-stream is the shape that silently drops an
  // invoice: it is filtered out before any ledger row exists.
  step('attachment-type', function () {
    const fake = function (name, type) {
      return {
        getName: function () { return name; },
        getContentType: function () { return type; }
      };
    };
    const cases = [
      ['a.pdf',  'application/pdf',              'application/pdf'],
      ['a.pdf',  'application/octet-stream',     'application/pdf'],
      ['A.PDF',  'application/octet-stream',     'application/pdf'],
      ['a.jpg',  'application/octet-stream',     'image/jpeg'],
      ['a.png',  'binary/octet-stream',          'image/png'],
      ['a.pdf',  'application/pdf; charset=bin', 'application/pdf'],
      ['a.docx', 'application/octet-stream',     ''],
      ['a.zip',  'application/zip',              ''],
      ['note',   'application/octet-stream',     '']
    ];
    cases.forEach(function (c) {
      const got = attachmentType_(fake(c[0], c[1]));
      if (got !== c[2]) {
        throw new Error(c[0] + ' + ' + c[1] + ' -> "' + got + '", expected "' + c[2] + '"');
      }
    });
    return cases.length + ' cases';
  });

  // Guards the seam every filing path shares: capture, the extraction retry and
  // reprocessRow all decide an outcome through classifyAttachment_.
  step('classify-and-file', function () {
    if (!extracted) throw new Error('no extraction to classify');
    const patch = classifyAttachment_('billing@acme-cloud.example', sample.copyBlob(), extracted, {});
    if (patch.status !== STATUS.FILED) {
      throw new Error('expected FILED, got ' + patch.status + ' (' + patch.notes + ')');
    }
    DriveApp.getFileById(patch.driveFileId).setTrashed(true); // clean up immediately
    return 'FILED as ' + patch.driveFileName + ', supplier=' + patch.supplier;
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
