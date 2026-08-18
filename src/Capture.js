/**
 * Stage 1 + 2: search Gmail, extract with Gemini, rename, file to Drive, record
 * in the ledger. Deterministic and idempotent (dedupe on Gmail message id).
 */

function runCapture() {
  const seen = seenMessageIds_(); // one ledger read; per-message dedupe backstop
  const fps = contentFingerprints_(); // content dedupe: supplier+date+amount+currency
  const query = gmailQuery_() + ' newer_than:' + CFG.GMAIL_LOOKBACK_DAYS + 'd';
  const threads = GmailApp.search(query, 0, CFG.MAX_THREADS_PER_RUN);
  const touched = []; // messages that produced a ledger row with an Inbox state

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      if (seen[msg.getId()]) return;
      const atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true })
        .filter(isSupportedAttachment_);
      if (!atts.length) return;

      let recorded = false;
      atts.forEach(function (att) {
        try {
          // A duplicate takes the state of the invoice it copies, so it has to
          // sync too. It pins its thread in the Inbox on its own otherwise.
          if (processAttachment_(msg, att, fps) !== 'SKIPPED') recorded = true;
        } catch (e) {
          recorded = true;
          Logger.log('Capture error msg %s: %s', msg.getId(), e);
          ledgerAppend_({
            id: Utilities.getUuid(), receivedAt: new Date(), gmailMsgId: msg.getId(),
            sender: msg.getFrom(), status: STATUS.ERROR, notes: String(e).slice(0, 300)
          });
        }
      });
      if (recorded) touched.push(msg.getId());
      seen[msg.getId()] = true; // don't re-run this message later in the same batch
    });
  });

  // Label the affected threads and leave every unpaid one in the Inbox. Pure
  // non-invoice matches of the broad search are untouched: they are normal mail.
  syncThreads_(touched);
}

function isSupportedAttachment_(att) {
  const t = att.getContentType();
  return t === 'application/pdf' || t === 'image/jpeg' || t === 'image/png';
}

/**
 * Whether a document was issued BY you rather than to you. An invoice you
 * sent is not an expense and must not be filed or paid.
 */
function isOwnIssuer_(name) {
  const own = ownCompanyName_();
  if (!own) return false;
  return String(name || '').toLowerCase().indexOf(own.toLowerCase()) >= 0;
}

/**
 * True for an invoice you raised on a customer through Qonto, which Qonto
 * mails out under a sender ending "(via Qonto)". Extraction cannot catch
 * these. The customer is the only company name on the document, so it comes
 * back as the supplier and every issuer guard passes. This money arrives
 * rather than leaves, so such a document never matches a debit and would sit
 * unresolved for ever.
 */
function isQontoOutbound_(from) {
  return /\(via\s+qonto\)/i.test(String(from || ''));
}

/**
 * @param {Object} fps content-fingerprint set, mutated as invoices are filed
 * @return {'FILED'|'DUPLICATE'|'SKIPPED'} anything but 'SKIPPED' needs a thread sync.
 */
function processAttachment_(msg, att, fps) {
  const base = function (extra) {
    const o = { id: Utilities.getUuid(), receivedAt: new Date(), gmailMsgId: msg.getId(), sender: msg.getFrom() };
    Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
  };

  // Checked before extraction: it is decided by the sender, and skipping early
  // saves the Gemini call.
  if (isQontoOutbound_(msg.getFrom())) {
    ledgerAppend_(base({ status: STATUS.NOT_INVOICE, notes: 'issued by you via Qonto (outbound), skipped: ' + att.getName() }));
    return 'SKIPPED';
  }

  let data;
  try {
    data = geminiExtract_(att.copyBlob());
  } catch (e) {
    // No ledger row: seenMessageIds_ indexes every row whatever its status, so
    // writing one here would skip this message on every later run.
    Logger.log('extraction failed for %s, will retry: %s', att.getName(), e);
    return 'SKIPPED';
  }
  if (!data || !data.isInvoice) {
    ledgerAppend_(base({ supplierRaw: (data && data.supplier) || '', status: STATUS.NOT_INVOICE, notes: att.getName() }));
    return 'SKIPPED';
  }
  // Hard guard: a document you issued is outbound, never an inbound bill.
  if (isOwnIssuer_(data.supplier)) {
    ledgerAppend_(base({ supplierRaw: data.supplier || '', status: STATUS.NOT_INVOICE, notes: 'issued by you (outbound), skipped: ' + att.getName() }));
    return 'SKIPPED';
  }
  if (data.isInbound === false) {
    ledgerAppend_(base({ supplierRaw: data.supplier || '', status: STATUS.NOT_INVOICE, notes: 'outbound/self-billed, skipped: ' + att.getName() }));
    return 'SKIPPED';
  }

  const supplier = resolveSupplier_(senderDomain_(msg.getFrom()), data.supplier);
  const invoiceDate = normalizeDate_(data.invoiceDate);
  const isoDate = invoiceDate ? Utilities.formatDate(invoiceDate, tz_(), 'yyyy-MM-dd') : '';
  const amount = Number(data.amount) || 0;
  const currency = (data.currency || '').toUpperCase();

  // Content dedupe: don't file the same invoice twice (invoice+receipt, resend, etc.).
  const fp = fpKey_(supplier, isoDate, amount, currency, data.invoiceNumber);
  if (fps[fp]) {
    ledgerAppend_(base({
      supplier: supplier, supplierRaw: data.supplier || '', invoiceDate: isoDate,
      amount: amount, currency: currency, invoiceNumber: data.invoiceNumber || '',
      status: STATUS.DUPLICATE, notes: 'duplicate of already-filed [' + fp + ']'
    }));
    return 'DUPLICATE';
  }

  const filed = fileInvoice_(att.copyBlob(), supplier, invoiceDate, data.invoiceNumber);
  ledgerAppend_(base({
    supplier: supplier,
    supplierRaw: data.supplier || '',
    invoiceDate: isoDate,
    amount: amount,
    currency: currency,
    invoiceNumber: data.invoiceNumber || '',
    driveFileId: filed.id,
    driveFileName: filed.name,
    status: STATUS.FILED,
    attempts: 0,
    lastCheckedAt: '',
    notes: data.confidence < 0.6 ? 'low extraction confidence' : '',
    supplierIban: (data.supplierIban || '').replace(/\s+/g, '')
  }));
  fps[fp] = true;
  return 'FILED';
}

function senderDomain_(from) {
  const m = /<([^>]+)>/.exec(from) || [null, from];
  const addr = (m[1] || from).trim();
  const at = addr.lastIndexOf('@');
  return at >= 0 ? addr.slice(at + 1).toLowerCase() : '';
}

function normalizeDate_(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
