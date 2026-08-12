# UpForBeers

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
| `POST /broadcast` | `x-beer-key` | `{ userId, name, message? }` | writes a signal, pushes to everyone else |
| `POST /join` | `x-beer-key` | `{ userId, name, message? }` | writes a signal, pushes only to people already up |
| `POST /leave` | none | `{ userId }` | deletes the signal, no push |
| `GET /state?userId=` | none | | active roster with seconds left and note per person |

A signal lives 3 hours, set in the config block at the top of `lambda/index.mjs`. There is no rate limit on calling a round: a broadcast always writes the signal and fans out, so a double tap sends twice.

`message` is an optional free text note. It is whitespace collapsed and truncated to `CONFIG.maxMessageLength` server side, appended to the notification body after a colon, stored on the signal, and returned by `/state` so it also shows in the roster. Omitted or blank, the notification reads exactly as before.

## Config knobs

- `lambda/index.mjs`: `CONFIG.signalTtlSeconds`, `CONFIG.maxMessageLength`, `CONFIG.appName`.
- Lambda env vars: `TABLE_NAME`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `APP_URL`.
- Secrets in SSM: `/upforbeers/vapid-private`, `/upforbeers/passphrase`.

## Setup

See [SETUP.md](SETUP.md). Deploy the Lambda first and exercise it with the curl block in step 7, then fill in `config.js`, then wire up Pages and DNS.
