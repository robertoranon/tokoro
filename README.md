# Tokoro

Tokoro is a thin, collaborative event calendar layer on top of the web. It is not a replacement for event platforms like Eventbrite or Resident Advisor — instead it lets a group of curators harvest events from those sites and other venue pages, and pool them into a shared geo-located calendar that anyone can query. The components are building blocks: use the included web interface as-is, or build your own app or feed directly on top of the API.

Imagine a loose network of jazz fans spread across a country, each keeping an eye on venues and promoters they follow. One of them lands on a label's tour page listing a dozen dates across different cities. Rather than manually copying each one, they use one of the browser tools to point the LLM at the page — it reads whatever structure the page happens to use, extracts all the events at once with their dates, locations, and categories, and presents them for a quick review. One click to publish, and all twelve gigs are in the shared calendar, signed under their key. Adding ten events takes the same effort as adding one.

Each event is stored with its coordinates. A friend planning a trip to London for a week in July opens the web interface, sets a location and radius around the area they'll be staying, picks a date range, and instantly sees everything the group has curated there — concerts, club nights, pop-ups — sorted by date. No algorithm, no feed to scroll.

You can checkout the public web interface of my tokoro DB instance [**here**](<[here](https://happenings-query.pages.dev/)>).

Events are queryable through a simple API. Point it at a location, a radius, and a time interval, and you get back a list of events — ready to power a mobile app, a newsletter, a Telegram bot, or any other tool you want to build on top.

**No accounts.** Identity is a local Ed25519 keypair — no registration, no email, no passwords. Every event is signed by its author and the backend verifies signatures before accepting writes.

**Runs on Cloudflare free tier.** The backend is Cloudflare Workers + D1 (SQLite). Both the API worker and the crawler worker fit comfortably within Cloudflare's free tier for moderate traffic. LLM cost is minimal.

**Self-hosted and open.** Anyone can run their own instance. Events are signed with a stable public key, so authorship is verifiable across instances and over time.

---

## Components

```
                     ┌────────────────────────────────────────────┐
                     │            Client tools                    │
                     │  Chrome Ext · Bookmarklet · Apple Shortcut │
                     └──────┬─────────────────────────┬───────────┘
                            │ POST /crawl             │ POST /events (signed)
                ┌───────────▼──────────────┐          │
                │      Crawler Worker      │          │
                │  Fetch → LLM extract     │          │
                │  → PreparedEvent[]       │          │
                └───────────┬──────────────┘          │
                            │ unsigned events         │
                            └─────────────────────────┘
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
| [**Chrome Extension**](chrome-extension/) | One-click crawl from the browser toolbar or right-click menu                      |
| [**Bookmarklet**](public-web/)            | Same capability in any browser, no extension install needed                       |
| [**Web Publisher**](web-publisher/)       | Static HTML form for manually composing and publishing events                     |
| [**Public Web**](public-web/)             | Example event browser — query by location, date, category; embeds the bookmarklet |
| [**Admin Panel**](admin/)                 | Static HTML moderation UI — browse and delete events with admin key auth          |
| [**Node.js Crawler**](crawler/)           | CLI crawler using Playwright / Jina AI Reader                                     |

---

## Documentation

- [Setup Guide](HOW-TO-USE.md)
- [API Reference](API_REFERENCE.md)
- [Worker ReadMe](worker/README.md)
- [Crawler Worker ReadMe](crawler-worker/README.md)
- [Chrome Extension ReadMe](chrome-extension/README.md)
- [Public Web ReadMe](public-web/README.md)

---

## License

[MIT](LICENSE)
