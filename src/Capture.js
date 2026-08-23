/**
 * Stage 1 + 2: search Gmail, extract with Gemini, rename, file to Drive, record
 * in the ledger. Deterministic and idempotent (dedupe on Gmail message id).
 */

function runCapture() {
  const seen = seenMessageIds_(); // one ledger read; per-message dedupe backstop
  const fps = contentFingerprints_(); // content dedupe: supplier+date+amount+currency
  // Messages that produced a ledger row with an Inbox state. Retried rows are
  // re-read by message id: a failure outlives the search window below.
  const touched = retryFailedExtractions_(fps);
  const query = gmailQuery_() + ' newer_than:' + CFG.GMAIL_LOOKBACK_DAYS + 'd';
  const threads = GmailApp.search(query, 0, CFG.MAX_THREADS_PER_RUN);

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
 * @return {'FILED'|'DUPLICATE'|'RECORDED'|'SKIPPED'} 'SKIPPED' leaves the thread
 *   alone; anything else needs a thread sync.
 */
function processAttachment_(msg, att, fps) {
  const base = function (extra) {
    const o = {
      id: Utilities.getUuid(), receivedAt: new Date(), gmailMsgId: msg.getId(),
      sender: msg.getFrom(), driveFileName: att.getName()
    };
    Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
  };

  // Checked before extraction: it is decided by the sender, and skipping early
  // saves the Gemini call.
  if (isQontoOutbound_(msg.getFrom())) {
    ledgerAppend_(base({ status: STATUS.OUT_OF_SCOPE, notes: 'issued by you via Qonto (outbound)' }));
    return 'SKIPPED';
  }

  let data;
  try {
    data = geminiExtract_(att.copyBlob());
  } catch (e) {
    // Writing no row loses the document once the search window passes it. The
    // row keeps the attachment name so retryFailedExtractions_ finds it again.
    Logger.log('extraction failed for %s, will retry: %s', att.getName(), e);
    ledgerAppend_(base({
      status: STATUS.EXTRACT_FAILED, attempts: 1, lastCheckedAt: new Date(),
      notes: String(e).slice(0, 300)
    }));
    return 'RECORDED';
  }

  const patch = classifyAttachment_(msg.getFrom(), att, data, fps);
  ledgerAppend_(base(patch));
  if (patch.status === STATUS.FILED) return 'FILED';
  if (patch.status === STATUS.DUPLICATE) return 'DUPLICATE';
  return 'SKIPPED';
}

/**
 * Decide what an extracted document is and, when it is an inbound invoice,
 * file it in Drive. Returns the ledger fields that describe the outcome; the
 * caller decides whether they become a new row or update an existing one.
 * @param {Object} fps content-fingerprint set, mutated as invoices are filed
 * @return {Object} ledger field patch, always carrying `status`
 */
function classifyAttachment_(from, att, data, fps) {
  if (!data || !data.isInvoice) {
    return { supplierRaw: (data && data.supplier) || '', status: STATUS.NOT_INVOICE,
             notes: 'extraction judged this not an invoice' };
  }
  // Hard guard: a document you issued is outbound, never an inbound bill.
  if (isOwnIssuer_(data.supplier)) {
    return { supplierRaw: data.supplier || '', status: STATUS.OUT_OF_SCOPE,
             notes: 'issued by you (outbound)' };
  }
  if (data.isInbound === false) {
    return { supplierRaw: data.supplier || '', status: STATUS.OUT_OF_SCOPE,
             notes: 'outbound/self-billed' };
  }

  const supplier = resolveSupplier_(senderDomain_(from), data.supplier);
  const invoiceDate = normalizeDate_(data.invoiceDate);
  const isoDate = invoiceDate ? Utilities.formatDate(invoiceDate, tz_(), 'yyyy-MM-dd') : '';
  const amount = Number(data.amount) || 0;
  const currency = (data.currency || '').toUpperCase();
  const common = {
    supplier: supplier, supplierRaw: data.supplier || '', invoiceDate: isoDate,
    amount: amount, currency: currency, invoiceNumber: data.invoiceNumber || ''
  };

  // Content dedupe: don't file the same invoice twice (invoice+receipt, resend, etc.).
  const fp = fpKey_(supplier, isoDate, amount, currency, data.invoiceNumber);
  if (fps[fp]) {
    return Object.assign(common, {
      status: STATUS.DUPLICATE, notes: 'duplicate of already-filed [' + fp + ']'
    });
  }

  const filed = fileInvoice_(att.copyBlob(), supplier, invoiceDate, data.invoiceNumber);
  fps[fp] = true;
  return Object.assign(common, {
    driveFileId: filed.id,
    driveFileName: filed.name,
    status: STATUS.FILED,
    attempts: 0,
    lastCheckedAt: '',
    notes: data.confidence < 0.6 ? 'low extraction confidence' : '',
    supplierIban: (data.supplierIban || '').replace(/\s+/g, '')
  });
}

/**
 * The supported attachment named `name` on a message, or the only one when the
 * name is blank. Reads the message by id, so it reaches mail of any age.
 * @return {GmailAttachment|null}
 */
function messageAttachment_(msgId, name) {
  const msg = GmailApp.getMessageById(msgId);
  if (!msg) return null;
  const atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true })
    .filter(isSupportedAttachment_);
  if (!atts.length) return null;
  if (!name) return atts.length === 1 ? atts[0] : null;
  for (let i = 0; i < atts.length; i++) {
    if (atts[i].getName() === name) return atts[i];
  }
  return null;
}

/**
 * Re-extract the rows whose extraction call failed, updating each row in place.
 * Re-running the Gmail search cannot do this: the row outlives the search
 * window, and re-reading a message would re-file the siblings that already
 * succeeded. Bounded by MAX_EXTRACT_ATTEMPTS.
 * @param {Object} fps content-fingerprint set, mutated as invoices are filed
 * @return {string[]} gmailMsgIds whose row changed state
 */
function retryFailedExtractions_(fps) {
  const touched = [];
  ledgerFindByStatus_([STATUS.EXTRACT_FAILED]).forEach(function (item) {
    const o = item.obj;
    const attempts = Number(o.attempts) || 0;
    if (attempts >= CFG.MAX_EXTRACT_ATTEMPTS) return;

    let att;
    try {
      att = messageAttachment_(String(o.gmailMsgId), String(o.driveFileName || ''));
    } catch (e) {
      ledgerUpdate_(item.rowNumber, {
        status: STATUS.ERROR, lastCheckedAt: new Date(), notes: String(e).slice(0, 300)
      });
      touched.push(String(o.gmailMsgId));
      return;
    }
    if (!att) {
      ledgerUpdate_(item.rowNumber, {
        status: STATUS.ERROR, lastCheckedAt: new Date(),
        notes: 'attachment not found on the message'
      });
      touched.push(String(o.gmailMsgId));
      return;
    }

    let data;
    try {
      data = geminiExtract_(att.copyBlob());
    } catch (e) {
      ledgerUpdate_(item.rowNumber, {
        attempts: attempts + 1, lastCheckedAt: new Date(), notes: String(e).slice(0, 300)
      });
      return;
    }

    try {
      const patch = classifyAttachment_(o.sender, att, data, fps);
      patch.attempts = patch.status === STATUS.FILED ? 0 : attempts + 1;
      patch.lastCheckedAt = new Date();
      ledgerUpdate_(item.rowNumber, patch);
      touched.push(String(o.gmailMsgId));
    } catch (e) {
      Logger.log('Extract retry error row %s: %s', item.rowNumber, e);
      ledgerUpdate_(item.rowNumber, {
        attempts: attempts + 1, lastCheckedAt: new Date(), notes: String(e).slice(0, 300)
      });
    }
  });
  return touched;
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
