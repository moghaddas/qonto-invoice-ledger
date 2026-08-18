/**
 * Stage 3: match filed invoices to Qonto debits, attach the receipt, then
 * re-label and archive the mail thread each one arrived on.
 * Conservative: only a single, unambiguous STRONG match auto-attaches, and
 * anything else is left for the next run and eventually flagged for review.
 * Retries cover transactions that settle days after the invoice.
 */

function runReconcile() {
  const pending = ledgerFindByStatus_([STATUS.FILED, STATUS.REVIEW, STATUS.SCHEDULED])
    .filter(function (item) { return stillMatchable_(item.obj); });
  if (!pending.length) return;
  const touched = [];
  const pool = debitPool_(pending);

  pending.forEach(function (item) {
    const inv = item.obj;
    if (inv.gmailMsgId) touched.push(String(inv.gmailMsgId));
    try {
      reconcileOne_(item.rowNumber, inv, pool);
    } catch (e) {
      Logger.log('Reconcile error row %s: %s', item.rowNumber, e);
      ledgerUpdate_(item.rowNumber, {
        attempts: (Number(inv.attempts) || 0) + 1,
        lastCheckedAt: new Date(),
        notes: String(e).slice(0, 300)
      });
    }
  });

  // Re-label after every row is settled: paid threads archive, the rest move to
  // the label matching whatever is still outstanding on them.
  syncThreads_(touched);
  sweepSettledInInbox_();
}

/**
 * A candidate debit has to sit inside [invoiceDate - BEFORE, invoiceDate +
 * AFTER], so once that window closes the same query returns the same pool on
 * every run. Keep retrying an unresolved invoice only while the window is open.
 * The digest still lists it, and attachManually() resolves it by hand.
 */
function stillMatchable_(inv) {
  if (String(inv.status) !== STATUS.REVIEW) return true; // FILED always retries
  const d = inv.invoiceDate ? new Date(inv.invoiceDate) : null;
  if (!d || isNaN(d.getTime())) return false;            // no date, no window
  return addDays_(d, CFG.MATCH_WINDOW_DAYS_AFTER) >= new Date();
}

/**
 * Every debit that could match any pending row, read in one pass.
 *
 * Reading per row instead costs one paged /transactions walk per invoice. Two
 * dozen rows then approach the six-minute execution ceiling and earn a rate
 * limit. That surfaces as a throw, the per-row catch counts it as a failed
 * attempt, and MAX_ATTEMPTS eventually parks a matchable invoice in review for
 * a reason that has nothing to do with matching.
 */
function debitPool_(pending) {
  let from = null, to = null;
  pending.forEach(function (item) {
    const d = item.obj.invoiceDate ? new Date(item.obj.invoiceDate) : null;
    if (!d || isNaN(d.getTime())) return;
    const f = addDays_(d, -CFG.MATCH_WINDOW_DAYS_BEFORE_FALLBACK);
    const t = addDays_(d, CFG.MATCH_WINDOW_DAYS_AFTER);
    if (!from || f < from) from = f;
    if (!to || t > to) to = t;
  });
  return from ? qontoDebits_(from, to) : [];
}

function reconcileOne_(rowNumber, inv, pool) {
  const attempts = (Number(inv.attempts) || 0) + 1;
  const invoiceDate = inv.invoiceDate ? new Date(inv.invoiceDate) : null;
  if (!invoiceDate || !inv.amount || !inv.currency) {
    ledgerUpdate_(rowNumber, { status: STATUS.REVIEW, attempts: attempts, lastCheckedAt: new Date(),
      notes: 'incomplete extraction (date/amount/currency)' });
    return;
  }

  const from = addDays_(invoiceDate, -CFG.MATCH_WINDOW_DAYS_BEFORE_FALLBACK);
  // Not clamped to today: a scheduled transfer is dated in the future, and
  // clamping would put it outside the range the query asks for.
  const to = addDays_(invoiceDate, CFG.MATCH_WINDOW_DAYS_AFTER);
  const now = new Date();

  // Queued transfers sit outside /transactions entirely, so they are a second
  // source rather than another status on the first one.
  const queued = qontoScheduledTransfers_().filter(function (t) {
    const d = new Date(t.emitted_at);
    return d >= from && d <= to;
  });

  const scored = pool
    .filter(function (t) {
      const d = new Date(t.emitted_at);
      return d >= from && d <= to;
    })
    .concat(queued)
    .map(function (t) { return { t: t, score: scoreMatch_(inv, t) }; });
  const candidates = scored
    .filter(function (c) { return c.score.amountExact; }) // amount+currency is mandatory
    .sort(function (a, b) { return b.score.total - a.score.total; });

  // The tight window wins whenever it holds a strong match. Only an empty tight
  // window falls back to the wider one, so a monthly vendor's previous debit
  // never competes with the current one.
  const tightFrom = addDays_(invoiceDate, -CFG.MATCH_WINDOW_DAYS_BEFORE);
  const tightStrong = candidates.filter(function (c) {
    return c.score.strong && new Date(c.t.emitted_at) >= tightFrom;
  });
  const strong = tightStrong.length ? tightStrong
                                    : candidates.filter(function (c) { return c.score.strong; });
  const executed = strong.filter(function (c) { return !isScheduled_(c.t); });
  const scheduled = strong.filter(function (c) { return isScheduled_(c.t); });
  const free = executed.filter(function (c) { return !hasAttachment_(c.t); });
  const taken = executed.filter(function (c) { return hasAttachment_(c.t); });

  // A debit with no receipt is the one to attach to. Falling back to a debit
  // that already has one settles an invoice reconciled by hand in Qonto:
  // attachAndMark_ re-checks live and links it without uploading a second copy.
  if (free.length === 1) {
    attachAndMark_(rowNumber, inv, free[0].t);
    return;
  }
  if (!free.length && taken.length === 1) {
    attachAndMark_(rowNumber, inv, taken[0].t);
    return;
  }
  // Money is committed but not moved. The invoice is handled, so the thread
  // leaves the Inbox. No receipt goes up yet: the transaction only takes one
  // once it settles, and this row keeps reconciling until it does.
  if (!executed.length && scheduled.length === 1) {
    markScheduled_(rowNumber, scheduled[0].t);
    return;
  }

  // No confident single match. Keep retrying until it settles or goes stale.
  const stale = attempts >= CFG.MAX_ATTEMPTS || daysSince_(invoiceDate, now) > CFG.STALE_REVIEW_DAYS;
  ledgerUpdate_(rowNumber, {
    status: (free.length > 1 || taken.length > 1 || scheduled.length > 1 || stale)
      ? STATUS.REVIEW : STATUS.FILED,
    attempts: attempts,
    lastCheckedAt: new Date(),
    notes: candidates.length ? describeCandidates_(strong.length ? strong : candidates)
                             : describeNearMisses_(inv, scored)
  });
}

/**
 * Record a queued payment. No upload: Qonto takes a receipt only once the
 * transaction exists and is completed, so the row keeps reconciling until then.
 * qontoTxnId stays empty for a queued transfer, because its id belongs to
 * /sepa/transfers and every reader of that column resolves ids against
 * /transactions.
 */
function markScheduled_(rowNumber, txn) {
  ledgerUpdate_(rowNumber, {
    status: STATUS.SCHEDULED,
    qontoTxnId: txn.scheduled === true ? '' : txn.id,
    qontoAccountId: txn.bank_account_id,
    lastCheckedAt: new Date(),
    notes: 'payment scheduled for ' + String(txn.emitted_at).slice(0, 10) +
      ' (' + (txn.label || txn.reference || '') + ') [' + txn.id + ']'
  });
}

function attachAndMark_(rowNumber, inv, txn) {
  // Re-check live in case it was attached manually since the list was fetched.
  const live = qontoGetTransaction_(txn.id);
  if (live.attachment_ids && live.attachment_ids.length) {
    ledgerUpdate_(rowNumber, { status: STATUS.ATTACHED, qontoTxnId: txn.id,
      qontoAccountId: txn.bank_account_id, lastCheckedAt: new Date(),
      notes: 'already had an attachment; linked' });
    return;
  }
  const file = DriveApp.getFileById(inv.driveFileId);
  const idem = idempotencyKey_(txn.id, inv.driveFileId);
  if (dryRun_()) {
    // Stay on FILED so the row keeps reconciling and keeps reporting the same
    // decision. Turning DRY_RUN off then attaches it on the next run.
    ledgerUpdate_(rowNumber, {
      attempts: (Number(inv.attempts) || 0) + 1,
      lastCheckedAt: new Date(),
      notes: '[dry-run] would attach to ' + txn.id + ' (' + (txn.label || '') + ')'
    });
    return;
  }
  qontoAttach_(txn.id, file.getBlob(), idem);
  ledgerUpdate_(rowNumber, {
    status: STATUS.ATTACHED,
    qontoTxnId: txn.id,
    qontoAccountId: txn.bank_account_id,
    lastCheckedAt: new Date(),
    notes: 'auto-attached (' + txn.label + ')'
  });
}

/**
 * Score a candidate. amountExact is gated on amount and currency agreeing on
 * either the account figure (EUR) or the original local one (FX, e.g. a USD
 * invoice). A STRONG match also needs the counterparty to agree, by name, by
 * invoice number, or by IBAN.
 */
function scoreMatch_(inv, t) {
  const cur = String(inv.currency).toUpperCase();
  const amt = Number(inv.amount);
  const amountExact =
    (t.currency && t.currency.toUpperCase() === cur && near_(t.amount, amt)) ||
    (t.local_currency && t.local_currency.toUpperCase() === cur && near_(t.local_amount, amt));

  // Match the invoice against the transaction's name AND remark fields.
  const haystack = [t.label, t.reference, t.note, t.clean_counterparty_name].filter(Boolean).join(' ');
  const nameScore = nameSimilarity_(inv.supplier, haystack, inv.supplierRaw);
  const nameHit = nameScore >= CFG.NAME_MATCH_MIN;

  // Invoice number appearing in the payment reference: strong corroboration.
  const invNo = normRef_(inv.invoiceNumber);
  const invNoHit = invNo.length >= 4 && normRef_(t.reference).indexOf(invNo) >= 0;

  // Vendor IBAN matching the transfer counterparty: the strongest signal.
  const cp = t.transfer && t.transfer.counterparty_account_number;
  const ibanHit = !!inv.supplierIban && !!cp && normIban_(inv.supplierIban) === normIban_(cp);

  return {
    amountExact: amountExact,
    nameScore: nameScore,
    counterparty: nameHit || invNoHit || ibanHit,
    strong: amountExact && (nameHit || invNoHit || ibanHit),
    total: (amountExact ? 1 : 0) + nameScore + (invNoHit ? 0.5 : 0) + (ibanHit ? 1 : 0)
  };
}

function near_(a, b) { return Math.abs(Number(a) - Number(b)) <= CFG.AMOUNT_TOLERANCE; }
function normRef_(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function normIban_(s) { return String(s || '').toUpperCase().replace(/\s+/g, ''); }

/**
 * How much of the SUPPLIER name appears in the transaction label, 0..1.
 * Normalised by the supplier's own tokens: a bank label carries extra words
 * ("ANTHROPIC* CLAUDE SUB"), and dividing by its length drags a correct match
 * below NAME_MATCH_MIN. One hit in three words scores 0.33 against a 0.34 bar.
 */
function nameSimilarity_(supplier, label, supplierRaw) {
  const A = distinct_(tokens_(supplier).concat(tokens_(supplierRaw)));
  const B = tokens_(label);
  if (!A.length || !B.length) return 0;
  const setB = {};
  B.forEach(function (x) { setB[x] = true; });
  let hits = 0;
  A.forEach(function (x) { if (setB[x]) hits++; });
  // Suppliers bill as "Eleven Labs Inc.", banks post "ELEVENLABS.IO": no token
  // agrees, so compare the names with the word breaks removed as well.
  const joined = A.join('');
  if (!hits && joined.length >= 6 && B.join('').indexOf(joined) >= 0) return 1;
  // Denominator caps at two: a bank prints the brand and drops the rest, so
  // "LinkedIn" alone out of "LinkedIn Ireland Unlimited Company" is a hit, not
  // a third of one. Amount and currency still have to agree exactly.
  return hits / Math.min(A.length, 2);
}

function distinct_(list) {
  const seen = {}, out = [];
  list.forEach(function (x) { if (!seen[x]) { seen[x] = true; out.push(x); } });
  return out;
}

// Card and direct-debit labels separate the vendor with symbols the plain
// punctuation set misses, so strip those too. Accented letters must survive:
// a negated ASCII class would cut "Müller" into "m" + "ller".
function tokens_(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[_\-.,*\/\\#+&|@()\[\]:;]/g, ' ')
    .replace(/\b(gmbh|inc|ltd|limited|unlimited|llc|bv|sarl|sas|ag|co|corp|corporation|company|holdings|the)\b/g, ' ')
    .split(/\s+/)
    .filter(function (w) { return w.length >= 3; });
}

/**
 * The counterparty is right but the amount is not, so nothing can auto-attach.
 * A card charge can carry more than the invoice it pays, because a
 * failed-payment fee rides along on the retry, and a bank never splits that
 * back out. Naming the charge and the gap turns a dead "no matching debit yet"
 * into a row somebody can settle with attachManually(). Silence here reads as
 * "nothing arrived", which is the opposite of the truth.
 *
 * A person reads this note before deciding whether to attach by hand, so the
 * delta has to be in the currency the invoice is written in. Comparing a EUR
 * account amount against a USD invoice reports the exchange rate as a
 * shortfall and makes a correct charge look wrong.
 */
function describeNearMisses_(inv, pool) {
  const amt = Number(inv.amount);
  const cur = String(inv.currency || '').toUpperCase();
  const near = pool
    .filter(function (c) { return c.score.counterparty; })
    .map(function (c) {
      const sameLocal = c.t.local_currency &&
        String(c.t.local_currency).toUpperCase() === cur;
      const shown = sameLocal ? Number(c.t.local_amount) : Number(c.t.amount);
      return {
        t: c.t,
        comparable: sameLocal ||
          (c.t.currency && String(c.t.currency).toUpperCase() === cur),
        shown: shown,
        shownCurrency: sameLocal ? c.t.local_currency : c.t.currency,
        delta: shown - amt
      };
    })
    .sort(function (a, b) { return Math.abs(a.delta) - Math.abs(b.delta); });
  if (!near.length) return 'no matching debit yet';
  return 'no debit matches the amount; same counterparty: ' + near.slice(0, 2).map(function (n) {
    const gap = n.comparable
      ? ' (' + (n.delta > 0 ? '+' : '') + n.delta.toFixed(2) + ')'
      : ' (different currency)';
    return n.t.label + ' ' + n.shown + ' ' + n.shownCurrency + ' @' +
      String(n.t.emitted_at).slice(0, 10) + gap + ' [' + n.t.id + ']';
  }).join(' | ');
}

function describeCandidates_(list) {
  if (!list.length) return 'no matching debit yet';
  return list.slice(0, 3).map(function (c) {
    return c.t.label + ' ' + c.t.amount + ' ' + c.t.currency +
      ' @' + String(c.t.emitted_at).slice(0, 10) + ' [' + c.t.id + ']';
  }).join(' | ');
}

function idempotencyKey_(txnId, fileId) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, txnId + '|' + fileId);
  const hex = raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  // Shape as a UUID-ish string.
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

function addDays_(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
/**
 * Signed, so a future-dated document reads as negative. An absolute value
 * marks a proforma dated two months ahead as stale on its first pass, before
 * its payment window has opened.
 */
function daysSince_(d, now) { return (now - d) / 86400000; }
