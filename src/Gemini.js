/**
 * Invoice extraction via Gemini. Sends the raw PDF/image bytes with a strict
 * JSON schema and lets the model classify + extract in one call.
 * GEMINI_API_KEY (AI Studio, https://aistudio.google.com/apikey) in Script
 * Properties.
 */

const INVOICE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isInvoice: { type: 'BOOLEAN' }, // invoice, bill, OR payment receipt/confirmation
    isInbound: { type: 'BOOLEAN' }, // an expense you pay, receipts included; false only if self-billed or outbound
    supplier: { type: 'STRING' },   // issuer / vendor name
    invoiceDate: { type: 'STRING' },// YYYY-MM-DD; issue date, not due date
    amount: { type: 'NUMBER' },     // gross total incl. VAT
    currency: { type: 'STRING' },   // ISO 4217, e.g. EUR, USD
    invoiceNumber: { type: 'STRING' },
    supplierIban: { type: 'STRING' }, // vendor IBAN for payment, if shown (else '')
    confidence: { type: 'NUMBER' }  // 0..1 self-rated extraction confidence
  },
  required: ['isInvoice', 'isInbound', 'supplier', 'invoiceDate', 'amount', 'currency', 'confidence']
};

/**
 * The company name goes into the prompt because isInbound turns on it: the
 * model has to know which party on the page is the reader.
 */
function extractPrompt_() {
  const own = ownCompanyName_() || 'the reader';
  return [
    'You are an accounting assistant for ' + own + '. The attached file may be a',
    'supplier invoice, bill, or payment receipt. Extract structured data. Rules:',
    '- isInvoice: true if this is an invoice, bill, OR a payment receipt/confirmation.',
    '- isInbound: true if the document relates to money ' + own + ' pays a SUPPLIER',
    '  for goods or services. This INCLUDES both invoices and payment receipts,',
    '  paid or not: a card-charge receipt from a vendor is inbound=true.',
    '  Set false ONLY for a self-billed statement or payout generated on behalf of',
    '  ' + own + ', which is how payment processors and affiliate networks report',
    '  what they owe, or for an invoice ' + own + ' ISSUED to its own customer.',
    '- invoiceDate: the ISSUE date in YYYY-MM-DD (for a receipt, the payment date).',
    '- amount: the gross total actually payable, including VAT or tax, as a number.',
    '- currency: ISO 4217 code.',
    '- supplier: the vendor or issuer legal or brand name, not the recipient.',
    '- supplierIban: the vendor IBAN shown for payment, spaces stripped, else empty.',
    '- If a field is genuinely absent, use an empty string, or 0 for amount.'
  ].join('\n');
}

/**
 * @param {Blob} blob  PDF/JPEG/PNG attachment
 * @return {Object|null} extracted fields or null on hard failure
 */
function geminiEndpoint_() {
  const model = CFG.GEMINI_MODEL;
  const googleKey = prop_('GEMINI_API_KEY', false);
  const aigToken = prop_('CF_AIG_TOKEN', false);

  // Gateway path, taken when an account and a gateway name are both set. The
  // token is needed only by an authenticated gateway.
  const acct = prop_('CF_AIG_ACCOUNT_ID', false);
  const gw = prop_('CF_AIG_GATEWAY', false);
  if (acct && gw) {
    const headers = {};
    if (aigToken) headers['cf-aig-authorization'] = 'Bearer ' + aigToken;
    // Omit the Google key only when the gateway holds it itself, through BYOK.
    if (googleKey) headers['x-goog-api-key'] = googleKey;
    return {
      url: 'https://gateway.ai.cloudflare.com/v1/' + acct + '/' + gw +
           '/google-ai-studio/v1beta/models/' + model + ':generateContent',
      headers: headers
    };
  }

  // Direct Google endpoint.
  if (!googleKey) throw new Error('Set GEMINI_API_KEY (or CF_AIG_TOKEN for the gateway)');
  return {
    url: CFG.GEMINI_BASE_URL + '/' + model + ':generateContent',
    headers: { 'x-goog-api-key': googleKey }
  };
}

function geminiExtract_(blob) {
  const ep = geminiEndpoint_();
  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) } },
        { text: extractPrompt_() }
      ]
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: INVOICE_SCHEMA
    }
  };
  const res = UrlFetchApp.fetch(ep.url, {
    method: 'post',
    contentType: 'application/json',
    headers: ep.headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  // Throw rather than return null. A rate limit or a gateway timeout is a
  // failure to read the document, not a decision that it is not an invoice,
  // and the two must not reach the caller as the same value: recording a
  // transient failure as a classification loses the invoice for good.
  if (res.getResponseCode() !== 200) {
    throw new Error('Gemini ' + res.getResponseCode() + ': ' +
                    res.getContentText().slice(0, 300));
  }
  try {
    const body = JSON.parse(res.getContentText());
    const text = body.candidates[0].content.parts[0].text;
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Gemini returned an unreadable body: ' + e);
  }
}
