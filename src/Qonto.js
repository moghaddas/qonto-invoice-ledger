/**
 * Qonto Business API client.
 * Auth: `Authorization: <secret_key>` (API key). If your key is the older
 * login:secret pair, also set QONTO_LOGIN and the header becomes login:secret.
 */

/**
 * The queued-transfer set for this execution. It is organisation-wide and the
 * same for every ledger row, so it is fetched once rather than per row.
 */
let SCHEDULED_TRANSFER_CACHE = null;

/** Bank account ids for this execution, resolved once. */
let ACCOUNT_ID_CACHE = null;

/**
 * The accounts to scan. QONTO_ACCOUNT_IDS narrows it; left unset, every
 * account the API key can read is scanned, which is what a new installation
 * wants before it knows which account pays which supplier.
 */
function accountIds_() {
  if (ACCOUNT_ID_CACHE) return ACCOUNT_ID_CACHE;
  const chosen = qontoAccounts_();
  if (chosen.length) {
    ACCOUNT_ID_CACHE = chosen;
    return chosen;
  }
  const org = qontoGet_('/organization', {}).organization || {};
  ACCOUNT_ID_CACHE = (org.bank_accounts || []).map(function (a) { return a.id; });
  if (!ACCOUNT_ID_CACHE.length) throw new Error('Qonto returned no bank accounts');
  return ACCOUNT_ID_CACHE;
}

function qontoAuthHeader_() {
  const secret = prop_('QONTO_SECRET_KEY', true);
  const login = prop_('QONTO_LOGIN', false);
  return login ? (login + ':' + secret) : secret;
}

function qontoGet_(path, params) {
  // Qonto's list filters repeat the key — status[]=completed&status[]=pending.
  // A joined value is read as one literal status and silently matches nothing,
  // so an array has to expand into one pair per element.
  const parts = [];
  Object.keys(params || {}).forEach(function (k) {
    const v = params[k];
    if (Object.prototype.toString.call(v) === '[object Array]') {
      v.forEach(function (x) { parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(x)); });
    } else {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
  });
  const qs = parts.length ? '?' + parts.join('&') : '';
  const res = UrlFetchApp.fetch(CFG.QONTO_BASE_URL + path + qs, {
    method: 'get',
    headers: { Authorization: qontoAuthHeader_() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Qonto GET ' + path + ' -> ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText());
}

/**
 * Debits across the given accounts, emitted within [from, to] — the
 * candidate pool Stage 3 matches against. Debits that already carry an
 * attachment are included: one of those means the invoice was reconciled in
 * Qonto by hand, so the ledger row has to settle against it instead of being
 * retried for ever. Stage 3 prefers a debit with no attachment.
 */
function qontoDebits_(fromDate, toDate) {
  const accounts = accountIds_();
  const from = fromDate.toISOString();
  const to = toDate.toISOString();
  const out = [];

  accounts.forEach(function (acct) {
    let page = 1;
    for (;;) {
      const data = qontoGet_('/transactions', {
        bank_account_id: acct,
        emitted_at_from: from,
        emitted_at_to: to,
        side: 'debit',
        // pending is a transaction in flight: the balance is not debited yet but
        // the transfer is being processed. It must not be attached to, only
        // recognised. A transfer scheduled for a future date has no transaction
        // at all — qontoScheduledTransfers_ is the only way to see one.
        'status[]': ['completed', 'pending'],
        per_page: 100,
        page: page
      });
      (data.transactions || []).forEach(function (t) {
        if (t.side === 'debit') out.push(t);
      });
      const next = data.meta && data.meta.next_page;
      if (!next) break;
      page = next;
    }
  });
  return out;
}

/**
 * SEPA transfers Qonto has accepted but not executed, shaped like the debits
 * they will become so one matcher covers both. A transfer only becomes a
 * transaction when it is processed, so a payment scheduled for a future date is
 * invisible to /transactions under every status — it lives here alone.
 *
 * Only `pending` is taken: the moment a transfer starts `processing` Qonto
 * creates the transaction, which qontoDebits_ already returns. Taking both would
 * put the same payment in the pool twice and resolve to nothing.
 *
 * The whole pending set is small and organisation-wide, so it is fetched once
 * per execution and the caller filters it by date.
 * @return {Object[]} transaction-shaped, each carrying scheduled:true
 */
function qontoScheduledTransfers_() {
  if (SCHEDULED_TRANSFER_CACHE) return SCHEDULED_TRANSFER_CACHE;

  const accounts = {};
  accountIds_().forEach(function (a) { accounts[a] = true; });
  const raw = [];
  let page = 1;
  for (;;) {
    const data = qontoGet_('/sepa/transfers', {
      'status[]': ['pending'], per_page: 100, page: page
    });
    (data.transfers || []).forEach(function (tr) {
      // Filtered again here: a status filter the API ignores would otherwise
      // put settled transfers into the pool as if they were still queued.
      if (tr.status === 'pending' && accounts[tr.bank_account_id]) raw.push(tr);
    });
    const next = data.meta && data.meta.next_page;
    if (!next) break;
    page = next;
  }

  // A transfer names its counterparty only by id, and the matcher needs a name
  // or an IBAN to call anything a strong match. Resolved once, and only when
  // there is something to resolve.
  const bene = raw.length ? qontoBeneficiaries_() : {};
  SCHEDULED_TRANSFER_CACHE = raw.map(function (tr) {
    const b = bene[tr.beneficiary_id] || {};
    return {
      id: tr.id,
      scheduled: true,
      amount: tr.amount,
      currency: tr.amount_currency,
      label: b.name || '',
      reference: tr.reference,
      note: tr.note,
      emitted_at: tr.scheduled_date,
      bank_account_id: tr.bank_account_id,
      transfer: { counterparty_account_number: b.iban || '' },
      attachment_ids: []
    };
  });
  return SCHEDULED_TRANSFER_CACHE;
}

/** @return {Object} beneficiary id -> {name, iban} */
function qontoBeneficiaries_() {
  const out = {};
  let page = 1;
  for (;;) {
    const data = qontoGet_('/sepa/beneficiaries', { per_page: 100, page: page });
    (data.beneficiaries || []).forEach(function (b) {
      out[b.id] = { name: b.name || '', iban: b.iban || '' };
    });
    const next = data.meta && data.meta.next_page;
    if (!next) break;
    page = next;
  }
  return out;
}

function qontoGetTransaction_(id) {
  return qontoGet_('/transactions/' + id).transaction;
}

/**
 * Attach a file blob to a transaction. Idempotency key is deterministic per
 * (transaction, file) so a retried run cannot double-attach.
 * @return {boolean} true on HTTP 200 (accepted; processed asynchronously)
 */
function qontoAttach_(transactionId, blob, idempotencyKey) {
  if (dryRun_()) {
    // The one call that writes to the bank. A dry run must never reach it,
    // and this guard is the backstop for a caller that forgot to check.
    Logger.log('[dry-run] would attach %s to transaction %s',
               blob.getName(), transactionId);
    return false;
  }
  // UrlFetchApp builds multipart/form-data automatically when a payload field
  // is a Blob — do NOT set contentType, or the boundary won't be added.
  const res = UrlFetchApp.fetch(CFG.QONTO_BASE_URL + '/transactions/' + transactionId + '/attachments', {
    method: 'post',
    headers: {
      Authorization: qontoAuthHeader_(),
      'X-Qonto-Idempotency-Key': idempotencyKey || Utilities.getUuid()
    },
    payload: { file: blob },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code === 200 || code === 201) return true;
  throw new Error('Qonto attach -> ' + code + ': ' + res.getContentText().slice(0, 300));
}

/**
 * True while the money is committed but not moved — a queued transfer, or a
 * transaction Qonto is still processing. Neither takes a receipt yet.
 * The status test is written as "not one of the settled or dead statuses"
 * rather than status === 'pending' so an unexpected token cannot silently mark
 * a declined transfer as scheduled and archive an invoice nobody has paid.
 */
function isScheduled_(t) {
  if (t && t.scheduled) return true;
  const st = String(t && t.status);
  return st !== 'completed' && st !== 'declined' && st !== 'reversed';
}

/** True if the transaction already carries a receipt. */
function hasAttachment_(t) {
  return !!(t.attachment_ids && t.attachment_ids.length);
}
