// ---------------------------------------------------------------------------
// License server for Sari-Sari POS.
//
// A small Cloudflare Worker: it checks a license key, records which machines
// have used it, and lets the owner add or revoke keys. Keys and their
// activations live in Workers KV under `license:<KEY>`.
//
// Set the admin secret before deploying:
//   npx wrangler secret put ADMIN_SECRET
// Until that is done the admin endpoints answer 503 instead of accepting a
// well-known default password.
// ---------------------------------------------------------------------------

// Keys look like DTR-EHS4-HA7W-GFGV-PTQ6: a prefix and four groups of four.
const KEY_PREFIX = 'DTR';
const KEY_GROUPS = 4;
const KEY_LENGTH = KEY_GROUPS * 4;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const FALLBACK_SECRET = 'CHANGE-THIS-SECRET';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') return cors(preflight());

    if (pathname === '/' && request.method === 'GET') {
      return cors(json({ ok: true, service: 'sari-pos-license' }));
    }
    if (pathname === '/validate' && request.method === 'POST') return handleValidate(request, env);
    if (pathname === '/admin/add-key' && request.method === 'POST') return handleAddKey(request, env);
    if (pathname === '/admin/list-keys' && request.method === 'GET') return handleListKeys(request, env);
    if (pathname === '/admin/revoke' && request.method === 'POST') return handleRevoke(request, env);
    if (pathname === '/admin/reset' && request.method === 'POST') return handleReset(request, env);

    return cors(json({ success: false, message: 'Not found.' }, 404));
  },
};

// ------------------------------------------------------------------ checking

async function handleValidate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return cors(json({ valid: false, message: 'Expected a JSON body.' }, 400));
  }

  const key = normalizeKey(body.key);
  const machineId = String(body.machineId || '').trim();
  if (!key) return cors(json({ valid: false, message: 'Invalid license key.' }));
  if (!machineId) {
    return cors(json({ valid: false, message: 'License key and machine ID required.' }));
  }

  const stored = await env.LICENSE_KV.get(`license:${key}`);
  if (!stored) return cors(json({ valid: false, message: 'Invalid license key.' }));

  const license = JSON.parse(stored);
  if (license.revoked) {
    return cors(json({ valid: false, message: 'This license key has been revoked.' }));
  }
  if (license.expiresAt && new Date(license.expiresAt) < new Date()) {
    return cors(json({ valid: false, message: 'This license key has expired.' }));
  }

  // A machine that already activated does not use a second slot, so a
  // reinstall or a repaired PC does not lock the shop out of its own key.
  license.activations = Array.isArray(license.activations) ? license.activations : [];
  const known = license.activations.includes(machineId);
  if (!known && license.activations.length >= (license.maxActivations || 1)) {
    const limit = license.activations.length;
    return cors(
      json({
        valid: false,
        message: `This key is already activated on ${limit} computer${limit === 1 ? '' : 's'}.`,
      })
    );
  }

  if (!known) {
    license.activations.push(machineId);
    license.lastActivatedAt = new Date().toISOString();
    await env.LICENSE_KV.put(`license:${key}`, JSON.stringify(license));
  }

  return cors(json({ valid: true, message: 'License activated successfully.', machineId }));
}

// -------------------------------------------------------------------- admin

async function handleAddKey(request, env) {
  const body = await readBody(request);
  const denied = adminProblem(request, env, body);
  if (denied) return denied;

  const key = body.key ? normalizeKey(body.key) : generateKey();
  if (!key) {
    return cors(json({ success: false, message: 'That key is not in the DTR-XXXX-XXXX-XXXX-XXXX shape.' }));
  }

  if (await env.LICENSE_KV.get(`license:${key}`)) {
    return cors(json({ success: false, message: 'Key already exists.' }));
  }

  const license = {
    key,
    maxActivations: Number(body.maxActivations) > 0 ? Number(body.maxActivations) : 1,
    activations: [],
    createdAt: new Date().toISOString(),
    lastActivatedAt: null,
    expiresAt: body.expiresAt || null,
    revoked: false,
    note: String(body.note || ''),
  };
  await env.LICENSE_KV.put(`license:${key}`, JSON.stringify(license));
  return cors(json({ success: true, key }));
}

async function handleListKeys(request, env) {
  const denied = adminProblem(request, env, {});
  if (denied) return denied;

  const keys = [];
  let cursor;
  do {
    const page = await env.LICENSE_KV.list({ prefix: 'license:', cursor });
    for (const entry of page.keys) {
      const stored = await env.LICENSE_KV.get(entry.name);
      if (stored) keys.push(JSON.parse(stored));
    }
    cursor = page.cursor;
  } while (cursor);

  keys.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return cors(json({ success: true, keys }));
}

async function handleRevoke(request, env) {
  const body = await readBody(request);
  const denied = adminProblem(request, env, body);
  if (denied) return denied;

  const key = normalizeKey(body.key);
  const stored = key ? await env.LICENSE_KV.get(`license:${key}`) : null;
  if (!stored) return cors(json({ success: false, message: 'Key not found.' }));

  const license = JSON.parse(stored);
  license.revoked = true;
  license.revokedAt = new Date().toISOString();
  await env.LICENSE_KV.put(`license:${key}`, JSON.stringify(license));
  return cors(json({ success: true, message: `${key} is revoked.` }));
}

// Frees a key that was activated on a computer that is gone — a replaced PC or
// a reinstall that changed the machine ID. The key itself keeps working.
async function handleReset(request, env) {
  const body = await readBody(request);
  const denied = adminProblem(request, env, body);
  if (denied) return denied;

  const key = normalizeKey(body.key);
  const stored = key ? await env.LICENSE_KV.get(`license:${key}`) : null;
  if (!stored) return cors(json({ success: false, message: 'Key not found.' }));

  const license = JSON.parse(stored);
  license.activations = [];
  license.revoked = false;
  await env.LICENSE_KV.put(`license:${key}`, JSON.stringify(license));
  return cors(json({ success: true, message: `${key} can be activated again.` }));
}

// ------------------------------------------------------------------ helpers

function adminProblem(request, env, body) {
  const expected = env.ADMIN_SECRET || FALLBACK_SECRET;
  if (expected === FALLBACK_SECRET) {
    return cors(
      json(
        {
          success: false,
          message: 'ADMIN_SECRET is not set. Run: npx wrangler secret put ADMIN_SECRET',
        },
        503
      )
    );
  }
  const given = body.adminSecret || request.headers.get('X-Admin-Secret') || '';
  if (!safeEqual(given, expected)) {
    return cors(json({ success: false, message: 'Unauthorized.' }, 401));
  }
  return null;
}

// Compares two strings without letting the time taken hint at how much of the
// secret was right.
function safeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch (_) {
    return {};
  }
}

// Puts the printed dashes back so DTREHS4HA7WGFGVPTQ6 is the same key as
// DTR-EHS4-HA7W-GFGV-PTQ6, and returns '' for anything a key can never be: the
// alphabet leaves out 0, 1, I and O so no key can be misread.
function normalizeKey(raw) {
  const letters = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!letters.startsWith(KEY_PREFIX)) return '';
  const body = letters.slice(KEY_PREFIX.length);
  if (body.length !== KEY_LENGTH) return '';
  if (!/^[A-HJ-NP-Z2-9]+$/.test(body)) return '';
  return [KEY_PREFIX, ...body.match(/.{4}/g)].join('-');
}

function generateKey() {
  const parts = [];
  for (let group = 0; group < KEY_GROUPS; group++) {
    let part = '';
    for (let i = 0; i < 4; i++) {
      part += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    parts.push(part);
  }
  return `${KEY_PREFIX}-${parts.join('-')}`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function preflight() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
    },
  });
}

function cors(response) {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');
  return response;
}
