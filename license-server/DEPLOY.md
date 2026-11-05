# License server — how it works

The app does one thing with this server: it asks whether a key exists, and
whether this computer is allowed to use it. **Keys are created by the owner, not
by the app and not by this server.** The worker only reads and updates the
activation record of a key that is already there.

## Where the keys live

The worker is bound to the existing `LICENSE_KV` namespace on this Cloudflare
account — the same store the DTR app's keys are created in:

    kv_namespaces = [
      { binding = "LICENSE_KV", id = "6b20f3b5c40440419d114dd27cc33e32" }
    ]

So any key you create there works in Sari-Sari POS. Nothing needs to be added to
the app when a new key is made.

One consequence to know about: because the store is shared, a key's activation
list is shared too. That is usually what you want — the DTR app and this app
derive the machine ID the same way, so installing both on the same computer
counts as one activation, not two. Two different computers using one key will
count as two.

## Deploying (only needed when the code changes)

```bash
cd license-server
npx wrangler login
npx wrangler secret put ADMIN_SECRET   # the password for revoke / reset / list
npx wrangler deploy
```

Wrangler prints the URL; it must match `LICENSE_SERVER` in `main.js`:

    https://sari-pos-license.jencendencia.workers.dev

Check it is awake:

```bash
curl https://sari-pos-license.jencendencia.workers.dev/
# {"ok":true,"service":"sari-pos-license"}
```

## What the app asks

`POST /validate` with `{ "key": "DTR-…", "machineId": "…" }` answers:

| Answer | Meaning |
|---|---|
| `{"valid":true}` | The key exists and this computer may use it |
| `Invalid license key.` | No such key in the store |
| `This license key has been revoked.` | Key exists but was taken back |
| `This license key has expired.` | Past its `expiresAt` |
| `This key is already activated on N computers.` | Every seat is used |

The first successful answer is saved on the computer in `license.json`, so
selling keeps working with no internet afterwards.

## Managing keys

```bash
# what exists, and which computers have used each key
curl -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  https://sari-pos-license.jencendencia.workers.dev/admin/list-keys

# take a key back
curl -X POST https://sari-pos-license.jencendencia.workers.dev/admin/revoke \
  -H "Content-Type: application/json" \
  -d '{"adminSecret":"YOUR_ADMIN_SECRET","key":"DTR-EHS4-HA7W-GFGV-PTQ6"}'

# free the seats on a key whose computer was replaced, without losing the key
curl -X POST https://sari-pos-license.jencendencia.workers.dev/admin/reset \
  -H "Content-Type: application/json" \
  -d '{"adminSecret":"YOUR_ADMIN_SECRET","key":"DTR-EHS4-HA7W-GFGV-PTQ6"}'
```

`revoke` and `reset` change the record in the shared store, so they affect the
DTR app on that key too.

`seed.js` is still there but is not part of the normal flow — it only exists if
you ever want to create keys from the command line instead of by hand:

```bash
POS_ADMIN_SECRET=... node seed.js https://sari-pos-license.jencendencia.workers.dev 3
```

## Revoking on a computer that is already activated

The server only sees an activation when a key is entered. To take the app off a
machine that is already running, delete `license.json` from
`%APPDATA%\Sari-Sari POS\` on that machine and reopen the app.
