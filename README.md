# Chemical quote bot

A WhatsApp bot that reads broker inquiries in WhatsApp groups ("PA 2 ton Bhiwandi rate?") and replies with a priced quotation from your rate list. Booking and negotiation messages are acknowledged and handed to a person. A web dashboard runs it: rates, groups, reply templates, approvals and a simulator.

Built from the TRD "WhatsApp Group Quotation Bot" (Oct 2026).

## Run it

Needs Node.js 22.13 or newer.

```bash
npm install
npm test                                   # 88 tests: parser, quotes, safety rules, queue

# Try it without WhatsApp: a fake connection with a test group you can message from the dashboard
WA_TRANSPORT=mock ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='choose-a-long-one' npm start

# Link a real number
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='choose-a-long-one' npm start
```

Open http://localhost:3000 and sign in. On first start the owner account is created from `ADMIN_EMAIL` and `ADMIN_PASSWORD` (if no password is given, one is generated and printed in the log once).

To link WhatsApp, open **Live**, then on the bot's phone go to WhatsApp → Settings → Linked devices → Link a device and scan the code. Then:

1. **Settings:** enter the phone number shown in replies and check business hours.
2. **Rates:** check every price, then click **Confirm all prices for today**. Prices older than their freshness limit (24 h by default) are never quoted.
3. **Groups:** pick a group as the test group and try messages there. Turn auto-reply on group by group; every group starts off.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Dashboard port |
| `DATA_DIR` | `./data` | Database and WhatsApp session folder (keep it backed up and private) |
| `WA_TRANSPORT` | `baileys` | `baileys` for a real number, `mock` for local testing |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | | Owner account created on first start |
| `NODE_ENV` | | Set to `production` behind HTTPS so cookies are marked secure |
| `LOG_LEVEL` | `info` | Log detail |

More users: add them in Settings, or `npm run create-user -- "Name" email operator 'password'`.

## How it works

```
WhatsApp group ─► Baileys adapter ─► parser ─► checks + quote builder ─► reply queue ─► Baileys adapter ─► group
                                                    │                        (SQLite, survives restarts)
                                                    └─► approvals (bookings), unmatched list, alerts
```

| Folder | What it holds |
| --- | --- |
| `src/parser` | Splits a message into items (product, brand, origin, quantity), detects intent, scores confidence |
| `src/quote` | Builds the reply from templates; blocks zero, missing or stale prices |
| `src/bot` | `Transport` interface, Baileys and mock transports, the engine, safety rules |
| `src/web` | Express server, login and sessions, the dashboard API |
| `public` | Login page and dashboard (plain HTML, CSS and JS) |
| `test` | Automated tests, including every bad reply found in the earlier prototype |

### Safety rules

- Replies only in groups switched on, plus the test group.
- **Stop all replies** cancels queued replies at once. Operators can stop; only the owner can resume.
- Rate limits (default): 1 reply per group per 20 s, 30 per group per hour, 200 per hour overall. Over a limit, replies are held, not dropped.
- Outside business hours (default 9:00–21:00 IST) replies are held.
- The same message is answered once; the same question from the same person within 10 minutes is skipped.
- Bookings never get a price: the bot acknowledges and adds them to Approvals.
- When unsure (a misspelt product, or nothing from the catalogue), the bot stays silent and lists the message under Unmatched, where you can teach it the new word.
- Held replies can be rebuilt with current prices and sent from the Live view.

## Differences from the TRD in this prototype

| TRD | Prototype | Why |
| --- | --- | --- |
| PostgreSQL + Redis | SQLite (built into Node) for both data and the reply queue | One process, nothing else to install; the queue is still persistent |
| Bot and dashboard as separate processes | One process | Simpler to run; the modules are already separate |
| React dashboard | Plain HTML/JS, no build step | Easier to host and change |
| 2FA required for the owner | Not built yet | Next step |
| WhatsApp session encrypted at rest | Stored in `DATA_DIR` with owner-only permissions | Next step: encrypt the folder or the disk |
| 300 real inquiries in the test set | About 60 phrasings plus 30 chat messages | Needs anonymised messages from the real groups |
| Raw messages deleted after 180 days | Not built yet | Next step |

## Before going live

- WhatsApp does not allow unofficial clients like Baileys and can ban the number. Use a number kept only for the bot, keep volumes low, and ask group admins first.
- Run behind HTTPS (for example Caddy or nginx) with `NODE_ENV=production`.
- Back up `DATA_DIR` daily.
- The sample rates in the seed are from the old prototype. Check them all before turning on any broker group.
