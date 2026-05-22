# Tokoro

Finding out what's on near you is weirdly broken: events are scattered across dozens of sites, buried in social feeds, or locked behind logins. There's no common layer you can just query.
This is my attempt to build one — open source, self-hosted, LLM-powered.

Live demo of my instance: [**https://tokoro-query.pages.dev/**](https://tokoro-query.pages.dev/).

If you want to test event extraction tools, contact me for an API key.

Tokoro is a thin, collaborative event calendar layer on top of the web. Not a replacement for Eventbrite or Resident Advisor — instead, a way for curators to harvest events from those sites and pool them into a shared geo-located calendar anyone can query.

**Example:** Imagine a loose network of jazz fans spread across a country. One of them lands on a label's tour page listing a dozen dates across different cities. Rather than manually copying each one, they use one of the browser tools to point the LLM at the page — it reads whatever structure the page happens to use, extracts all the events at once with their dates, locations, and categories, and presents them for a quick review. One click to publish, and all twelve gigs are in the shared calendar, signed under their key. Adding ten events takes the same effort as adding one.

Each event is stored with its coordinates. A friend planning a trip to London for a week in July opens the web interface, sets a location and radius around where they'll be staying, picks a date range, and instantly sees everything the group has curated there — concerts, club nights, pop-ups — sorted by date. No algorithm, no feed to scroll.

Events are queryable through a simple API. Point it at a location, a radius, and a time interval, and you get back a list of events — ready to power a mobile app, a newsletter, a Telegram bot, or any other tool you want to build on top.

- **No accounts.** Identity is a local Ed25519 keypair — no registration, no email, no passwords. Every event is signed by its author and the backend verifies signatures before accepting writes.
- **Runs on Cloudflare free tier.** The backend is Cloudflare Workers + D1 (SQLite). Both the API worker and the crawler worker fit comfortably within Cloudflare's free tier for moderate traffic. LLM cost is minimal.
- **Self-hosted and open.** Anyone can run their own instance. Events are signed with a stable public key, so authorship is verifiable across instances and over time.

---

## Components

```
          ┌───────────────────────────────────────────────────────────┐
          │                      Client tools                         │
          │  Chrome Ext · Bookmarklet · Apple Shortcut · Telegram Bot │
          └──────┬──────────────────────────────┬─────────────────────┘
                 │ POST /crawl                  │ POST /events (signed)
     ┌───────────▼──────────────┐               │
     │      Crawler Worker      │               │
     │  Fetch → LLM extract     ├───────────────┘
     │  → PreparedEvent[]       │  bot signs & publishes via service binding
     │  POST /telegram (bot)    │
     └──────────────────────────┘
                                         │
              ┌──────────────────────────▼────────────────────┐
              │                Worker API                     │
              │  Events · Stars · Follows · Feed · Discover   │
              │          Cloudflare Workers + D1              │
              └──────────────────┬────────────────────────────┘
                                 │ GET /events
              ┌──────────────────▼────────────────────────────┐
              │             Public Web / Your App             │
              │  Query by location, time, category, tags      │
              └───────────────────────────────────────────────┘
```

| Component                                 | What it does                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| [**Worker**](worker/)                     | Cloudflare Worker + D1 backend — events, stars, follows, recommendations          |
| [**Crawler Worker**](crawler-worker/)     | Serverless LLM crawler — extract events (unsigned) from any URL or image          |
| [**Node.js Crawler**](crawler/)           | Local CLI crawler — Playwright/Jina fetching, direct/discover/festival/image modes |
| [**Chrome Extension**](chrome-extension/) | One-click crawl from the browser toolbar or right-click menu                      |
| [**Apple Shortcut**](public-web/)         | iOS Share Sheet integration — extract and publish events from Safari on iPhone    |
| [**Bookmarklet**](public-web/)            | Same capability in any browser, no extension install needed                       |
| [**Telegram Bot**](crawler-worker/)       | Send a URL or image to a Telegram bot — it crawls, extracts, and lets you publish with one tap |
| [**Web Publisher**](web-publisher/)       | Static HTML form for manually composing and publishing events                     |
| [**Public Web**](public-web/)             | Example event browser — query by location, date, category; embeds the bookmarklet |
| [**Admin Panel**](admin/)                 | Static HTML moderation UI — browse and delete events with admin key auth          |

---

## Documentation

- [Setup Guide](HOW-TO-USE.md)
- [API Reference](API_REFERENCE.md)
- [Worker ReadMe](worker/README.md)
- [Crawler Worker ReadMe](crawler-worker/README.md)
- [Node.js Crawler ReadMe](crawler/README.md)
- [Chrome Extension ReadMe](chrome-extension/README.md)
- [Public Web ReadMe](public-web/README.md)

---

## License

[Mozilla](LICENSE)
