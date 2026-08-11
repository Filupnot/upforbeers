# upforbeers

Tap a pint, every friend's phone buzzes with "Name is up for beers." They tap back to say they're in. That is the whole app.

## Shape

- **Frontend**: plain HTML, CSS, vanilla JS. No build step. Served off GitHub Pages at `https://upforbeers.philipknott.net`.
- **Backend**: one AWS Lambda (Node 22, ESM) behind a Function URL.
- **State**: one DynamoDB table, `upforbeers`, with TTL doing the cleanup.
- **Push**: Web Push via VAPID. Notification permission is requested on a real tap, never on load.

iOS only delivers web push to apps installed to the Home Screen, so the app gates itself behind an install screen until it is launched standalone.

## Files

```
index.html            markup
styles.css            the mockup's styles, verbatim palette and type
app.js                identity, polling, actions, the install and passphrase gates
sw.js                 service worker: always shows a notification, focuses or opens on click
manifest.webmanifest  standalone PWA manifest
config.js             FUNCTION_URL and VAPID_PUBLIC_KEY, both public
icons/                180 / 192 / 512 png plus the source svg
lambda/index.mjs      the single handler, all routes
SETUP.md              stand up the AWS side by hand, top to bottom
```

## API

One Lambda, dispatched on method and path.

| Route | Auth | Body | Does |
|---|---|---|---|
| `POST /subscribe` | none | `{ userId, name, subscription }` | upserts the push subscription, idempotent |
| `POST /broadcast` | `x-beer-key` | `{ userId, name }` | acquires the cooldown, writes a signal, pushes to everyone else |
| `POST /join` | `x-beer-key` | `{ userId, name }` | writes a signal, pushes only to people already up, no cooldown |
| `POST /leave` | none | `{ userId }` | deletes the signal, no push |
| `GET /state?userId=` | none | | active roster with seconds left per person, plus this user's cooldown seconds |

A signal lives 3 hours. Cooldown is 1 hour per person. Both are in the config block at the top of `lambda/index.mjs`.

The cooldown is a single atomic conditional `UpdateItem`, so a double tap cannot call two rounds. On a rejected write the Lambda returns 429 with `retryAfter` seconds, and the client renders the countdown from that server value, never from localStorage.

## Config knobs

- `lambda/index.mjs`: `CONFIG.signalTtlSeconds`, `CONFIG.cooldownSeconds`.
- Lambda env vars: `TABLE_NAME`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `APP_URL`.
- Secrets in SSM: `/upforbeers/vapid-private`, `/upforbeers/passphrase`.

## Setup

See [SETUP.md](SETUP.md). Deploy the Lambda first and exercise it with the curl block in step 7, then fill in `config.js`, then wire up Pages and DNS.
