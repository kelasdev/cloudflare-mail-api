# cloudflare-mail-api

A private, throwaway email API running entirely on Cloudflare Workers.

Create as many usernames as you need — each one becomes a real inbox like
`alice@mail.example.com`. Receive real email at those addresses, read them
through a small REST API, and let everything delete itself after 24 hours.
No accounts, no databases to manage, no mail to clean up later — the data
just disappears.

Built for things like signup verifications, 2FA codes, and newsletter
tests where you need a real inbox for a day and nothing after that.

---

## Features

- **One Worker, three jobs** — serves the REST API, receives inbound mail
  via Cloudflare Email Routing, and purges expired data on a cron schedule.
- **Many inboxes per key** — create `alice`, `bob`, `signup-1` … all alive
  at the same time, each with its own address and its own messages.
- **24-hour lifetime, enforced twice** — expired mail is hidden on every
  read *and* physically deleted every 15 minutes. Even if the cron never
  runs, expired data can never be read back.
- **Private by default** — a single API key decides everything. Inboxes
  are addressed by username; there are no opaque ids to pass around.
- **Timing-safe auth** — the API key is compared via SHA-256 digest with a
  constant-time check, not a plain string comparison.
- **It survives ugly email** — broken MIME still gets stored (best-effort
  subject + raw body), bodies over 256 KB are truncated and flagged.
- **Unknown recipients are dropped silently** — no bounce, no retry loop,
  no error thrown back into Email Routing.
- **Zero maintenance** — no outbound sending, no rate-limiter to tune, no
  frontend. It receives, stores, and forgets.

## How it works

```
sender ──SMTP──> Cloudflare Email Routing (your domain)
                     │ email event
                     v
              Worker "cloudflare-mail-api"
               ├── email()      receives mail, parses MIME, stores it
               ├── fetch()      REST API (X-API-Key)
               └── scheduled()  cron every 15 min: delete expired rows
                     │
                     v
                  D1 (SQLite)
               inboxes / messages
```

Every inbox lives exactly 24 hours from creation. Messages inherit their
inbox's expiry — a mail that arrives in hour 23 dies with its inbox, not
24 hours after it arrived.

## Quick start

Prerequisites: a Cloudflare account, a domain on Cloudflare, and Node.js 22+.

```bash
git clone <this-repo> && cd cloudflare-mail-api
npm install

# 1. Log in to Cloudflare
npx wrangler login

# 2. Create the database (copy the database_id from the output)
npx wrangler d1 create mail-api

# 3. Create your local config from the template
cp wrangler.example.toml wrangler.toml
#    -> paste the database_id into wrangler.toml
#    -> set MAIL_DOMAIN to the domain you use for Email Routing

# 4. Create the tables
npx wrangler d1 execute mail-api --remote --file schema.sql

# 5. Set the API key (use a long random value, e.g. openssl rand -hex 32)
npx wrangler secret put API_KEY

# 6. Deploy
npx wrangler deploy
```

Then, once, in the Cloudflare dashboard:
**Domain → Email → Email Routing → Routing rules → Catch-all →
Send to a Worker → `cloudflare-mail-api`.**

> `wrangler.toml` is intentionally gitignored (it holds your real
> `database_id` and domain). `wrangler.example.toml` is the committed
> template.

## Authentication

Every request needs the API key you set in step 5:

```
X-API-Key: <your-key>
```

Missing or wrong key → `401 {"error":"unauthorized"}`.

## API

Base URL: `https://cloudflare-mail-api.<your-account>.workers.dev`

Inboxes are addressed by username everywhere — `:username` in a path is
folded to lowercase and must obey the username rules below.

### Create a user

```
POST /api/v1/userlist
```

```json
{ "username": "alice" }
```

`201`:

```json
{
  "username": "alice",
  "address": "alice@mail.example.com",
  "created_at": 1759468800,
  "expires_at": 1759555200,
  "ttl_seconds": 86400
}
```

Username rules: 3–32 characters, folded to lowercase, letters/digits/`.`/`_`/`-`,
must start and end with a letter or digit, no `..`.

Usernames are unique while their inbox is alive: creating `bob` twice
within the same 24-hour window returns `409`, but `alice`, `bob`, and
`signup-1` coexist without limit. There is no cap on how many live inboxes
one key can hold. After an inbox expires, its username can be reused for a
fresh 24-hour cycle (and recreating it also clears the stale row if the
cron has not caught up yet).

```bash
curl -X POST "$W/api/v1/userlist" \
  -H "X-API-Key: ***" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice"}'
```

### List users

```
GET /api/v1/userlist
```

```json
[
  {
    "username": "alice",
    "address": "alice@mail.example.com",
    "created_at": 1759468800,
    "expires_at": 1759555200,
    "message_count": 3
  }
]
```

Live inboxes only (expired rows are hidden), newest first. `message_count`
only counts messages that have not expired yet.

### Check one user

```
GET /api/v1/user/:username
```

```json
{
  "username": "alice",
  "address": "alice@mail.example.com",
  "expires_at": 1759555200,
  "message_count": 3
}
```

Unknown or already-expired usernames return `404`.

### List messages

```
GET /api/v1/user/:username/messages?limit=20&offset=0
```

```json
[
  {
    "id": 1,
    "sender": "noreply@example.com",
    "subject": "Verify your email",
    "received_at": 1759470000
  }
]
```

`limit` defaults to 20 (max 100), `offset` defaults to 0. Newest first.
Scoped to the named inbox — ids from one inbox never resolve in another.

### Read one message

```
GET /api/v1/user/:username/messages/:id
```

```json
{
  "id": 1,
  "inbox_id": 1,
  "sender": "noreply@example.com",
  "recipient": "alice@mail.example.com",
  "subject": "Verify your email",
  "text": "Your code is 123456.",
  "html": "<p>Your code is <b>123456</b>.</p>",
  "received_at": 1759470000,
  "expires_at": 1759555200,
  "truncated": 0
}
```

`truncated: 1` means the body hit the 256 KB cap and was cut off.

Expired or unknown messages return `404` — even if the cleanup cron has
not run yet.

### Delete one message

```
DELETE /api/v1/user/:username/messages/:id
```

Always `204`, even if the message does not exist. Deleting an expired
message behaves the same as deleting a live one. Scoped to the named
inbox: deleting via another inbox's path is a no-op that still returns
`204`.

### Delete all messages

```
DELETE /api/v1/user/:username/messages
```

Empties only the named inbox, without touching the inbox itself → `204`.

## Errors

| Status | Body | When |
|--------|------|------|
| 400 | `{"error":"invalid_username","reason":"…"}` | username breaks the rules (create body only) |
| 401 | `{"error":"unauthorized"}` | missing or wrong `X-API-Key` |
| 404 | `{"error":"not_found"}` | no such live inbox, no message, unknown path, malformed username in path |
| 405 | `{"error":"method_not_allowed"}` | right path, wrong method |
| 409 | `{"error":"user_exists","address":…,"expires_at":…}` | username still alive |
| 422 | `{"error":"invalid_json"}` | request body is not valid JSON |
| 500 | `{"error":"internal"}` | something broke server-side |

## Expiry, in plain terms

Two layers, both always on:

1. **Read layer** — every list/get/count query filters
   `expires_at > now`, and every scoped route 404s an expired inbox
   before it even looks at messages. Expired rows are invisible the
   moment they expire.
2. **Cron layer** — every 15 minutes a two-step purge physically deletes
   expired messages first, then expired inboxes.

So: data never outlives 24 hours, and the cleanup schedule only affects
*when the disk is freed*, never *whether you can read old data* (you can't).

Mail sent to an address that is unknown or already expired is dropped
silently — that is intentional: this is a private service, and bouncing
would only flood a mailbox nobody watches.

## Development

```bash
npm test          # vitest: 23 tests, runs in the Workers runtime
npm run typecheck # tsc --noEmit
npm run dev       # wrangler dev (local)
```

Tests run against an in-memory D1 via `@cloudflare/vitest-pool-workers`,
including an end-to-end expiry gate: seed expired data, never run the
cron, and prove every read path still hides it.

Project layout:

```
src/
  index.ts         Worker entry: fetch / email / scheduled
  api.ts           REST router (auth, paths, status codes)
  store.ts         all D1 queries
  email-handler.ts inbound mail: parse, truncate, insert
  username.ts      username validation + address building
schema.sql         tables + indexes
test/              vitest suites
```

## Out of scope (on purpose)

- Sending mail — this only receives.
- Accounts, signups, public self-serve.
- Bounce/DSN generation.
- A web UI.
- Deleting an inbox before its 24 hours — inboxes die only via expiry + cron.

## License

ISC
