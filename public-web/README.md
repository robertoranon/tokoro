# Tokoro Public Web Query Interface

A simple web interface for querying events from the Tokoro API.

## Features

- Search events by location (address or coordinates)
- Filter by category and time range
- Geocoding support via OpenStreetMap Nominatim API
- Mobile-responsive design

## Deployment to Cloudflare Pages

### Option 1: Using Wrangler CLI (Recommended)

```bash
# Install Wrangler if you haven't already
npm install -g wrangler

# Deploy the public-web directory
wrangler pages deploy public-web --project-name happenings-query
```

### Option 2: Via Cloudflare Dashboard

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Go to **Pages** in the left sidebar
3. Click **Create a project**
4. Choose **Direct Upload**
5. Upload the contents of the `public-web` directory
6. Set the project name (e.g., `happenings-query`)
7. Click **Deploy**

### Option 3: Git Integration

1. Push this repository to GitHub/GitLab
2. In Cloudflare Dashboard, go to **Pages** → **Create a project**
3. Choose **Connect to Git**
4. Select your repository
5. Configure build settings:
   - **Build command:** (leave empty)
   - **Build output directory:** `public-web`
6. Click **Save and Deploy**

## Configuration

All URLs and keys are configured via `config.local.js` at the project root. Copy the example file and fill in your values:

```bash
cp config.local.js.example config.local.js
```

Then run `build-bookmarklet.js` (see below) to inject the values into the HTML files.

The default search location is **Udine, Italy** with a **100 km radius**. To change the default, edit the `value` attributes of the `queryLat`, `queryLng`, and `queryRadius` inputs in `index.html`.

## Building the Bookmarklet

The bookmarklet embedded in `index.html` is generated from `bookmarklet.src.js` by `build-bookmarklet.js`. Run it whenever you change the source or want to update the configuration:

```bash
node build-bookmarklet.js
```

The script reads `config.local.js`, substitutes placeholders, minifies the bookmarklet, and writes the results into `index.html` and `it.html`:

| Config key         | Placeholder             | Purpose                                                                                                     |
| ------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `relayUrl`         | `__RELAY_URL__`         | URL of this Cloudflare Pages site — used to open the relay popup                                           |
| `crawlerWorkerUrl` | `__DEFAULT_WORKER__`    | Default crawler-worker URL pre-filled in the bookmarklet settings                                          |
| `crawlerApiKey`    | `__DEFAULT_API_KEY__`   | Default API key pre-filled in the bookmarklet settings                                                      |
| `workerUrl`        | `__DEFAULT_API_URL__`   | Default API Worker URL pre-filled in the bookmarklet settings (also injected as `__TOKORO_WORKER_URL__` into `index.html` and `it.html`) |

Users can override `crawlerWorkerUrl`, `crawlerApiKey`, and `workerUrl` at runtime via the bookmarklet's settings panel; their values are saved to `localStorage` and restored on subsequent uses. The settings panel collapses automatically when all three values are configured.

## Local Testing

Simply open `index.html` in a web browser. No build step required.

## Bookmarklet Publisher

The bookmarklet relay (activated via `?relay=1` or by clicking the bookmarklet) generates an Ed25519 keypair on first use, stored in `localStorage` on the Pages origin. Events extracted by the Crawler Worker are signed locally with this keypair and published directly to the API worker — no signing happens server-side.

On first use the relay shows an amber notice with the new public key, prompting the curator to share it with the admin and back it up for other browsers. The bookmarklet also caches the public key locally and displays it in its settings panel after the first relay interaction.

To allow a new curator to publish, obtain their public key (shown in the relay first-use notice or the bookmarklet settings) and add it to the `ALLOWED_PUBKEYS` secret on the API worker.

## CORS Requirements

Make sure your Cloudflare Worker has CORS headers enabled to allow requests from the Cloudflare Pages domain.
