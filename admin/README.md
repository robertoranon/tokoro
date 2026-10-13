# Tokoro Admin Panel

A static HTML page (`admin.html`) for the instance admin. No build step: open it in a browser from the repo (`admin/admin.html`), so that it can load `../config.local.js`. It loads `@noble/ed25519` and a QR-code library from esm.sh, so it needs internet access.

## What it does

The page has three tabs:

- **Events**: search events (by id, title, publisher pubkey, date range, category) and delete them. Deletes are signed with the admin key, which may delete any event.
- **Members**: create members for the tours page ("My bands"), revoke them, or delete them with their followed bands and suggestions. Creating a member generates a new key in the browser and shows the member's **personal link** (`<public site>/tours.html#k=…`) with a QR code, once; the private key is not stored anywhere.
- **Suggestions**: the bands members suggested, grouped by name and most requested first ("Show who asked" adds member names). Select bands to copy them as a list for `npm run bands-scout`, reject them with an optional reason, or link them to a band that is already tracked. Below, the follower count of each band.

The blocklist has API endpoints (`/admin/blocklist`) but no UI on this page.

Step-by-step instructions for members and suggestions: [`HOW-TO-USE.md`](../HOW-TO-USE.md) section 10. The endpoints are specified in [`worker/SPECS.md`](../worker/SPECS.md) (sections 3.6 and 7.11-7.14).

## Settings

Saved in the browser's `localStorage`:

| Setting | Purpose |
| --- | --- |
| Worker URL | The API Worker; pre-filled from `workerUrl` in `config.local.js` |
| Public site URL | Where `tours.html` is hosted; used to build personal links. Pre-filled from `publicWebUrl` in `config.local.js` |
| Admin Private Key (hex) | Signs every admin request locally; never sent to the server |
| Admin Public Key (hex) | Must equal the Worker's `ADMIN_PUBKEY` secret |

## Files

- `admin.html`: the page
- `members-admin.js`: the admin API client for members and suggestions (signed requests), plus `buildMemberLink` and `bandsTxt`. A classic script: `window.TokoroAdminMembers` in the browser, `require()` in Node
- `tests/members-admin.test.mjs`: tests for the pure helpers

## Tests

From the repo root:

```bash
node admin/tests/members-admin.test.mjs
```

The admin client is also exercised against the real Worker by `worker/src/contract.test.ts` (`cd worker && npx vitest run`).
