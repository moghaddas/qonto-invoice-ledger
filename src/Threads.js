/**
 * Inbox state for invoice mail. A thread shows exactly one state label — the
 * worst among the invoices filed from it — and is archived once every one of
 * them is settled, meaning paid or scheduled for payment. State is derived from
 * the ledger, never from the labels, so a hand-edited label is corrected on the
 * next run.
 */

/** Ensure the state labels exist and are coloured. Called by setup(). */
function ensureGmailLabels_() {
  const colourByName = {};
  Object.keys(CFG.THREAD_LABELS).forEach(function (state) {
    const name = labelName_(state);
    // Gmail groups a nested label under its parents only when every ancestor
    // exists as a label of its own. Without them the sidebar shows one flat
    // entry with literal slashes in the name.
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      if (!GmailApp.getUserLabelByName(ancestor)) GmailApp.createLabel(ancestor);
    }
    if (!GmailApp.getUserLabelByName(name)) GmailApp.createLabel(name);
    colourByName[name] = CFG.THREAD_LABEL_COLORS[state];
  });
  applyLabelColours_(colourByName);
}

/**
 * Set the label chip colours. Colour is reachable only through the Gmail
 * advanced service (GmailApp has no API for it), so this is best-effort —
 * losing the colour must never stop invoices being filed.
 * @param {Object} colourByName label name -> {backgroundColor, textColor}
 */
function applyLabelColours_(colourByName) {
  try {
    (Gmail.Users.Labels.list('me').labels || []).forEach(function (l) {
      const want = colourByName[l.name];
      if (!want) return;
      const has = l.color || {};
      if (has.backgroundColor === want.backgroundColor && has.textColor === want.textColor) return;
      Gmail.Users.Labels.patch({ color: want }, 'me', l.id);
    });
  } catch (e) {
    Logger.log('Label colours skipped: %s', e);
  }
}

/** The state labels by state, created on demand so a run never needs setup(). */
function threadLabels_() {
  const out = {};
  Object.keys(CFG.THREAD_LABELS).forEach(function (state) {
    const name = labelName_(state);
    out[state] = GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
  });
  return out;
}

/**
 * Re-label the threads the given messages arrived on, and archive the settled
 * ones. One ledger read covers the whole batch.
 * @param {string[]} gmailMsgIds message ids touched this run
 */
function syncThreads_(gmailMsgIds) {
  const ids = (gmailMsgIds || []).filter(String);
  if (!ids.length) return;

  const stateByMsg = ledgerThreadStates_();
  // Skipped under a dry run: syncThread_ applies nothing, and building this
  // creates the five labels as a side effect.
  const labels = dryRun_() ? {} : threadLabels_();
  const snoozed = snoozedThreadIds_();
  const seenThread = {};

  ids.forEach(function (msgId) {
    const thread = threadOf_(msgId);
    if (!thread || seenThread[thread.getId()]) return;
    seenThread[thread.getId()] = true;
    syncThread_(thread, stateByMsg, labels, snoozed);
  });
}

/**
 * Apply the thread's state label, and archive it once everything on it is
 * settled. An unpaid, unmatched or errored sibling holds the whole thread in
 * the Inbox.
 * @param {Object} [snoozed] thread ids Gmail is holding snoozed; never disturbed
 * @return {string} the state applied, or '' when nothing on the thread is an invoice
 */
function syncThread_(thread, stateByMsg, labels, snoozed) {
  // Relabelling and archiving reorganise somebody's mailbox, and at fifty
  // threads a run that is not something to undo by hand. A dry run reports
  // the state it would have applied and touches nothing.
  const preview = dryRun_();
  const present = {};
  thread.getMessages().forEach(function (m) {
    (stateByMsg[m.getId()] || []).forEach(function (s) { present[s] = true; });
  });

  const worst = CFG.THREAD_STATE_ORDER.filter(function (s) { return present[s]; })[0];
  const settled = CFG.THREAD_STATES_SETTLED.indexOf(worst) >= 0;

  // No state left on the thread — a row reclassified as a non-invoice, say.
  // Strip our labels rather than leaving the last one stranded, and never
  // archive: with nothing invoice-related on it this is ordinary mail.
  const has = {};
  thread.getLabels().forEach(function (l) { has[l.getName()] = true; });
  // Read before the labels change: it says which side the thread was on last run.
  const wasSettled = CFG.THREAD_STATES_SETTLED.some(function (s) {
    return has[labelName_(s)];
  });
  CFG.THREAD_STATE_ORDER.forEach(function (s) {
    const name = labelName_(s);
    if (preview) return;
    if (s === worst) { if (!has[name]) thread.addLabel(labels[s]); }
    else if (has[name]) thread.removeLabel(labels[s]);
  });
  if (!worst) return '';
  if (preview) {
    Logger.log('[dry-run] would label thread %s as %s%s',
               thread.getId(), worst, settled ? ' and archive it' : '');
    return worst;
  }

  if (settled) {
    thread.moveToArchive();
  } else if (wasSettled && !thread.isInInbox() && !(snoozed || {})[thread.getId()]) {
    // It was settled and no longer is — a scheduled transfer was cancelled, or
    // a match was undone. The invoice is owed again, so it goes back where an
    // unpaid invoice belongs. This is the only path that returns a thread to the
    // Inbox, so an archive done by hand on never-settled mail still sticks, and
    // a snoozed thread is left for its own date.
    thread.moveToInbox();
  }
  return worst;
}

/**
 * Thread ids Gmail is holding as snoozed. Snooze is reachable only through the
 * search operator: it is not in a thread's labels and the SNOOZED label id
 * returns nothing as a filter, so `in:snoozed` is the only way to see it.
 * A snoozed invoice is one deliberately put aside until a payment date, and
 * moving it to the Inbox cancels that.
 */
function snoozedThreadIds_() {
  const out = {};
  GmailApp.search('in:snoozed', 0, 300).forEach(function (t) { out[t.getId()] = true; });
  return out;
}

/**
 * Archive settled threads that are sitting in the Inbox. A settled row is rarely
 * revisited, so a thread that returns on its own — a snooze expiring, or the
 * vendor replying on it — would otherwise stay there for good.
 */
function sweepSettledInInbox_() {
  const threads = [];
  const seen = {};
  CFG.THREAD_STATES_SETTLED.forEach(function (state) {
    const label = GmailApp.getUserLabelByName(labelName_(state));
    if (!label) return;
    label.getThreads(0, 100).forEach(function (t) {
      if (t.isInInbox() && !seen[t.getId()]) { seen[t.getId()] = true; threads.push(t); }
    });
  });
  if (!threads.length) return;
  const stateByMsg = ledgerThreadStates_();
  const labels = threadLabels_();
  const snoozed = snoozedThreadIds_();
  threads.forEach(function (t) { syncThread_(t, stateByMsg, labels, snoozed); });
}

/** @return {GmailThread|null} null when the message is gone or unreadable. */
function threadOf_(msgId) {
  try {
    return GmailApp.getMessageById(String(msgId)).getThread();
  } catch (e) {
    Logger.log('Thread lookup failed for message %s: %s', msgId, e);
    return null;
  }
}

/**
 * Manual repair: re-label every invoice thread in the ledger and pull the
 * unpaid ones back into the Inbox. Run from the editor. Safe to re-run — it
 * reads the ledger, so it converges on the same result every time.
 * @return {string} summary, also written to the execution log
 */
function restoreUnpaidToInbox() {
  const preview = dryRun_();
  if (!preview) ensureGmailLabels_();
  const stateByMsg = ledgerThreadStates_();
  const labels = threadLabels_();
  const snoozed = snoozedThreadIds_();
  const seenThread = {};
  let relabelled = 0, restored = 0, leftSnoozed = 0;

  Object.keys(stateByMsg).forEach(function (msgId) {
    const thread = threadOf_(msgId);
    if (!thread || seenThread[thread.getId()]) return;
    seenThread[thread.getId()] = true;

    const state = syncThread_(thread, stateByMsg, labels, snoozed);
    if (!state) return;
    relabelled++;
    if (CFG.THREAD_STATES_SETTLED.indexOf(state) >= 0 || thread.isInInbox()) return;
    // A snoozed invoice was put aside on purpose until its payment date.
    // Pulling it into the Inbox would cancel that, so leave it alone.
    if (snoozed[thread.getId()]) { leftSnoozed++; return; }
    if (preview) {
      Logger.log('[dry-run] would move thread %s back to the Inbox', thread.getId());
    } else {
      thread.moveToInbox();
    }
    restored++;
  });

  const summary = (preview ? '[dry-run] ' : '') + relabelled +
    ' thread(s) re-labelled, ' + restored + ' moved back to the Inbox, ' +
    leftSnoozed + ' left snoozed';
  Logger.log(summary);
  return summary;
}
