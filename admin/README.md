# Tokoro Admin Panel

A static HTML page (`admin.html`) for the instance admin. No build step: open it in a browser from the repo (`admin/admin.html`), so that it can load `../config.local.js`. It loads `@noble/ed25519` and a QR-code library from esm.sh, so it needs internet access.

## What it does

The page has four tabs:

- **Events**: search events (by id, title, publisher pubkey, date range, category) and delete them. Deletes are signed with the admin key, which may delete any event.
- **Members**: create members for the tours page and the festival radar ("My bands", "My festivals"), revoke them, or delete them with their followed bands and festivals and their suggestions. Creating a member generates a new key in the browser and shows the member's **personal link** (`<public site>/tours.html#k=…`) with a QR code, once; the private key is not stored anywhere.
- **Suggestions**: the bands or festivals members suggested (a **Bands / Festivals** switch), grouped by name and most requested first ("Show who asked" adds member names). Select entries to copy them (bands as a list for `npm run bands-scout`, festivals as ready-to-paste `festivals.yaml` entries), reject them with an optional reason, or link them to a band or festival that is already tracked. Below, the follower count of each band or festival.
- **Conflicts**: pairs of shows of one band on the same day that the worker held back from public listings (the badge counts the open ones; the Events tab shows held events too). For each conflict, **Delete this one** removes the wrong show, **Keep both** records that the band plays twice, and a crawler proposal ("Proposed by crawler: delete ...", raised when a source no longer lists a show) is accepted with **Apply**. Resolving releases the held events. Use the status filter to review kept and resolved conflicts. Conflicts are detected when a show is written; **Scan existing data** checks the shows already stored (for example after upgrading) and reports how many band-days it checked and how many new conflicts it found (run it again when it says more remain).

The blocklist has API endpoints (`/admin/blocklist`) but no UI on this page.

Step-by-step instructions for members and suggestions: [`HOW-TO-USE.md`](../HOW-TO-USE.md) section 10. The endpoints are specified in [`worker/SPECS.md`](../worker/SPECS.md) (sections 3.6 and 7.11-7.14a).

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
- `members-admin.js`: the admin API client for members and suggestions (signed requests), plus `buildMemberLink`, `bandsTxt` and `festivalsYaml`. A classic script: `window.TokoroAdminMembers` in the browser, `require()` in Node
- `conflicts-admin.js`: the signed client for the Conflicts tab (`window.TokoroAdminConflicts`, `require()` in Node)
- `tests/members-admin.test.mjs`, `tests/conflicts-admin.test.mjs`: tests for the clients and helpers

## Tests

From the repo root:

```bash
node --test admin/tests/*.test.mjs
```

The admin client is also exercised against the real Worker by `worker/src/contract.test.ts` (`cd worker && npx vitest run`).
