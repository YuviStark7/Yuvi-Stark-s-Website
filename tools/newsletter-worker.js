// Newsletter relay for yuvistark.com, deployed as a Cloudflare Worker.
//
// The signup form on the site posts { email, consent: true } here. This adds the
// address to Shopify's customer list with email marketing switched on: a plain
// customer record, no account, no password, nothing to sign in to. Only the Admin
// API can do that, and its credentials must never reach a browser, which is the
// whole reason this relay exists.
//
// Setup, once, in the Cloudflare dashboard (Workers & Pages > this Worker):
//   Settings > Variables and Secrets > Add, type Secret:
//     SHOPIFY_CLIENT_ID      the Dev Dashboard app's Client ID
//     SHOPIFY_CLIENT_SECRET  the Dev Dashboard app's Client secret
//   The app needs the read_customers and write_customers scopes and must be
//   installed on the store. Nothing secret lives in this file, so it is safe in
//   the public repo.
//
// What it records: marketingState SUBSCRIBED, opt-in level SINGLE_OPT_IN and the
// time of consent, tagged "newsletter" and "website". An address that already
// belongs to a customer (a past buyer, say) is switched on rather than rejected.
// Email addresses are never logged.

const SHOP            = '1erwh1-5t.myshopify.com';
const API_VERSION     = '2026-01';
const ALLOWED_ORIGINS = ['https://yuvistark.com', 'https://www.yuvistark.com'];
const EMAIL           = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Client credentials tokens last 24 hours. Keep one per isolate and renew it a
// minute early instead of asking Shopify for a new one on every signup.
let cached = { token: null, expires: 0 };

async function getToken(env){
  if(cached.token && Date.now() < cached.expires - 60000) return cached.token;
  // Pasting into the dashboard easily picks up a stray space or line break, which
  // Shopify then reports as an app it cannot find, so trim before sending.
  const id     = String(env.SHOPIFY_CLIENT_ID || '').trim();
  const secret = String(env.SHOPIFY_CLIENT_SECRET || '').trim();
  if(!id || !secret){
    // Say which one is missing and list the variable NAMES this Worker can see,
    // never their values, each in quotes so a stray space shows. A misspelt name,
    // or a secret saved as a build variable (which the running Worker never
    // receives), is then obvious straight from the log.
    const missing = [!id && 'SHOPIFY_CLIENT_ID', !secret && 'SHOPIFY_CLIENT_SECRET'].filter(Boolean).join(' and ');
    const seen    = Object.keys(env || {}).sort().map(k => JSON.stringify(k)).join(', ') || 'none';
    throw new Error(`token request skipped: ${missing} not set on this Worker (variables it can see: ${seen})`);
  }
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body   : new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret })
  });
  if(!res.ok){
    // Shopify answers every failure here with a 400 HTML page whose title names the
    // cause: "Oauth error application_cannot_be_found" when the Client ID or secret
    // matches no app, "Oauth error shop_not_permitted" when the app and the store
    // are not in the same organization. Log that name only, never the page.
    const text = await res.text().catch(() => '');
    const why  = (text.match(/Oauth error ([a-z_]+)/i) || text.match(/"error"\s*:\s*"([^"]+)"/) || [])[1] || 'no detail';
    throw new Error(`token request failed: ${res.status} ${why}`);
  }
  const json = await res.json();
  if(!json.access_token) throw new Error('token request failed: no access_token in the reply');
  cached = { token: json.access_token, expires: Date.now() + (json.expires_in || 86399) * 1000 };
  return cached.token;
}

async function admin(env, query, variables){
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken(env) },
    body   : JSON.stringify({ query, variables })
  });
  const json = await res.json().catch(() => ({}));
  if(!res.ok || (json.errors && json.errors.length))
    throw new Error(`admin api ${res.status}: ${JSON.stringify(json.errors || '')}`);
  return json.data;
}

const FIND = `query Find($id: CustomerIdentifierInput!) {
  customerByIdentifier(identifier: $id) { id emailMarketingConsent { marketingState } }
}`;
const CREATE = `mutation Create($input: CustomerInput!) {
  customerCreate(input: $input) { customer { id } userErrors { field message } }
}`;
const SUBSCRIBE = `mutation Subscribe($input: CustomerEmailMarketingConsentUpdateInput!) {
  customerEmailMarketingConsentUpdate(input: $input) { userErrors { field message } }
}`;

const fieldOf = e => Array.isArray(e.field) ? e.field.join('.') : String(e.field || '');

export default {
  async fetch(request, env){
    const origin  = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin' : allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age'      : '86400',
      'Vary'                        : 'Origin'
    };
    const reply = (status, body) => new Response(JSON.stringify(body),
      { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if(request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if(request.method !== 'POST')    return reply(405, { ok: false, error: 'method' });
    if(!allowed)                     return reply(403, { ok: false, error: 'origin' });

    let data;
    try { data = await request.json(); } catch(e){ return reply(400, { ok: false, error: 'bad_request' }); }
    const email = String((data && data.email) || '').trim().toLowerCase();
    if(!data || data.consent !== true)              return reply(400, { ok: false, error: 'no_consent' });
    if(email.length > 254 || !EMAIL.test(email))    return reply(400, { ok: false, error: 'invalid_email' });

    const consent = {
      marketingState     : 'SUBSCRIBED',
      marketingOptInLevel: 'SINGLE_OPT_IN',
      consentUpdatedAt   : new Date().toISOString()
    };

    try {
      const found = (await admin(env, FIND, { id: { emailAddress: email } })).customerByIdentifier;

      if(found){
        const state = found.emailMarketingConsent && found.emailMarketingConsent.marketingState;
        if(state !== 'SUBSCRIBED'){
          const r = await admin(env, SUBSCRIBE, { input: { customerId: found.id, emailMarketingConsent: consent } });
          const errs = r.customerEmailMarketingConsentUpdate.userErrors;
          if(errs.length) throw new Error(`consent update: ${JSON.stringify(errs.map(e => e.message))}`);
        }
        return reply(200, { ok: true });
      }

      const r = await admin(env, CREATE, { input: { email, emailMarketingConsent: consent, tags: ['newsletter', 'website'] } });
      const errs = r.customerCreate.userErrors;
      if(errs.length){
        // two submits racing each other: the first one already created it
        if(errs.some(e => /taken/i.test(e.message)))            return reply(200, { ok: true });
        if(errs.some(e => /email/i.test(fieldOf(e))))           return reply(400, { ok: false, error: 'invalid_email' });
        throw new Error(`create: ${JSON.stringify(errs.map(e => e.message))}`);
      }
      return reply(200, { ok: true });
    } catch(err){
      console.log('newsletter relay failed:', err.message);
      return reply(502, { ok: false, error: 'upstream' });
    }
  }
};
