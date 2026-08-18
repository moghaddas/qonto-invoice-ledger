/**
 * One-time bootstrap + trigger management.
 * Run `setup()` once from the Apps Script editor and authorise the scopes.
 */

function setup() {
  const props = PropertiesService.getScriptProperties();
  // Write the safe value on a fresh install, so DRY_RUN is visible in Project
  // Settings rather than an unset property the reader has to know about.
  if (props.getProperty('DRY_RUN') === null) props.setProperty('DRY_RUN', 'true');

  const required = ['INBOUND_FOLDER_ID', 'QONTO_SECRET_KEY'];
  // A gateway holding the Google key through BYOK is the one case that needs
  // no key of its own.
  if (!(props.getProperty('CF_AIG_ACCOUNT_ID') && props.getProperty('CF_AIG_GATEWAY'))) {
    required.push('GEMINI_API_KEY');
  }
  const missing = required.filter(function (k) { return !props.getProperty(k); });
  if (missing.length) {
    throw new Error('Set these Script Properties first: ' + missing.join(', '));
  }

  ensureLedger_();
  ensureGmailLabels_();
  installTriggers_();
  Logger.log('Setup complete. Ledger: %s', prop_('LEDGER_SHEET_ID', true));
  if (dryRun_()) {
    Logger.log('DRY_RUN is on. Invoices file to Drive and the ledger fills, ' +
               'but nothing is attached to a transaction and no mail moves. ' +
               'Set DRY_RUN to false once the ledger looks right.');
  }
}

function installTriggers_() {
  // Idempotent: clear ours, then reinstall.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'runCapture' || fn === 'runReconcile' || fn === 'runDigest') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Stage 1+2: capture + file, frequently.
  ScriptApp.newTrigger('runCapture').timeBased().everyMinutes(10).create();
  // Stage 3: match + attach, a few times a day (transactions settle slowly).
  ScriptApp.newTrigger('runReconcile').timeBased().everyHours(4).create();
  // Weekly review digest, Monday morning.
  ScriptApp.newTrigger('runDigest').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
}

function ensureLedger_() {
  let id = prop_('LEDGER_SHEET_ID', false);
  let ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('Finance – Invoice Ledger');
    id = ss.getId();
    PropertiesService.getScriptProperties().setProperty('LEDGER_SHEET_ID', id);
  }
  ensureTab_(ss, CFG.LEDGER_TAB, CFG.LEDGER_HEADERS);
  const sup = ensureTab_(ss, CFG.SUPPLIERS_TAB, CFG.SUPPLIERS_HEADERS);
  if (sup.getLastRow() < 2) {
    // Seed a couple of examples so the mapping shape is obvious.
    // Two shapes rather than two real vendors: match on the sending domain,
    // or on a phrase inside the name the model extracted.
    sup.appendRow(['domain', 'example-vendor.com', 'Example_Vendor']);
    sup.appendRow(['contains', 'cloud hosting', 'Cloud_Hosting']);
  }
  return ss;
}

function ensureTab_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return sh;
  }
  // Self-heal: append any newly-added headers as extra columns.
  const existing = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const missing = headers.filter(function (h) { return existing.indexOf(h) < 0; });
  if (missing.length) {
    sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    sh.getRange(1, existing.length + 1, 1, missing.length).setFontWeight('bold');
  }
  return sh;
}
