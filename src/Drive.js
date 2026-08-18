/**
 * Filing + supplier normalization. Path is built by INVOICE DATE:
 *   <INBOUND>/<YYYY>/<YYMM>/<YYMMDD_Supplier.ext>
 * Year and month subfolders are reused when they exist, created when they do not.
 */

function fileInvoice_(blob, supplier, invoiceDate, invoiceNumber) {
  const root = DriveApp.getFolderById(inboundFolderId_());
  const dt = invoiceDate || new Date();
  const yyyy = Utilities.formatDate(dt, tz_(), 'yyyy');
  const yymm = Utilities.formatDate(dt, tz_(), 'yyMM');
  const yymmdd = Utilities.formatDate(dt, tz_(), 'yyMMdd');

  const yearF = resolveOrCreateFolder_(root, yyyy + CFG.YEAR_FOLDER_SUFFIX, yyyy);
  const monthF = resolveOrCreateFolder_(yearF, yymm, yymm);

  const ext = extensionFor_(blob.getContentType());
  const base = yymmdd + '_' + sanitizeSupplier_(supplier);
  const name = uniqueName_(monthF, base, invoiceNumber, ext);

  blob.setName(name);
  const file = monthF.createFile(blob);
  return { id: file.getId(), name: name };
}

/**
 * Reuse the folder you already keep invoices in, whatever you called it. An
 * exact name wins. Failing that, any folder carrying `token` ("2026 Inbound
 * Invoices" for token "2026"). Failing that, `exactName` is created.
 * The token has to start the name or stand as its own word: a bare substring
 * test files 2026 into an existing "2019-2026 archive" and never says so.
 */
function resolveOrCreateFolder_(parent, exactName, token) {
  const exact = parent.getFoldersByName(exactName);
  if (exact.hasNext()) return exact.next();
  const anchored = new RegExp('(^|\\s)' + token + '(\\b|_|$)');
  const it = parent.getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (anchored.test(f.getName())) return f;
  }
  return parent.createFolder(exactName);
}

function extensionFor_(mime) {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/png') return 'png';
  return 'jpg';
}

/** Avoid clobbering a same-supplier-same-day invoice: disambiguate by number, then (n). */
function uniqueName_(folder, base, invoiceNumber, ext) {
  let candidate = base + '.' + ext;
  if (!folder.getFilesByName(candidate).hasNext()) return candidate;

  if (invoiceNumber) {
    candidate = base + '_' + sanitizeSupplier_(invoiceNumber) + '.' + ext;
    if (!folder.getFilesByName(candidate).hasNext()) return candidate;
  }
  let n = 2;
  while (folder.getFilesByName(base + ' (' + n + ').' + ext).hasNext()) n++;
  return base + ' (' + n + ').' + ext;
}

function sanitizeSupplier_(s) {
  return String(s || 'Unknown')
    .replace(/[\/\\:*?"<>|]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[._]+$/, '')   // no trailing dot/underscore -> avoids "Ltd..pdf"
    .slice(0, 60) || 'Unknown';
}

/**
 * Canonical supplier from the Suppliers tab: domain match wins, then a
 * case-insensitive "contains" on the raw name. Falls back to the raw name.
 */
function resolveSupplier_(domain, rawName) {
  const ss = SpreadsheetApp.openById(prop_('LEDGER_SHEET_ID', true));
  const sh = ss.getSheetByName(CFG.SUPPLIERS_TAB);
  const rows = sh.getLastRow() > 1
    ? sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues()
    : [];
  const raw = String(rawName || '').toLowerCase();

  for (let i = 0; i < rows.length; i++) {
    const type = String(rows[i][0]).toLowerCase();
    const pattern = String(rows[i][1]).toLowerCase().trim();
    const canonical = rows[i][2];
    if (!pattern || !canonical) continue;
    if (type === 'domain' && domain && domain.indexOf(pattern) >= 0) return canonical;
    if (type === 'contains' && raw && raw.indexOf(pattern) >= 0) return canonical;
  }
  return rawName || 'Unknown';
}
