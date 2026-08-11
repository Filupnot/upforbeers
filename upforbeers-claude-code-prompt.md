# Claude Code prompt: build `upforbeers`

Copy everything below the line into a fresh Claude Code session.

Before you do: make a folder, drop the mockup HTML in it as `mockup.html`, and run `git init`. That gives Claude Code the design reference to work from.

---

Build me a push notification web app called **upforbeers**. I tap a button, all my friends' phones buzz with "Philip is up for beers." They can tap back to say they're in.

There is a design mockup at `./mockup.html` in this repo. Read it first. It is a static single file prototype with hardcoded state, and it is the visual and copy reference for the real app. Keep the palette, typography, layout, animation, and wording. Replace the hardcoded state with real data. Do not redesign it.

## Constraints

- Frontend is plain HTML, CSS, and vanilla JS. No build step, no framework, no bundler. It gets served straight off GitHub Pages.
- Backend is a single AWS Lambda behind a Function URL, Node 22, ESM.
- State lives in one DynamoDB table.
- I am a full stack engineer, so write real code and skip the tutorial commentary. TypeScript is not needed here since there is no build step on either side.
- Do not use em-dashes or en-dashes anywhere, in code, comments, or docs.

## Domain and hosting

Production origin is `https://upforbeers.philipknott.net`, served by GitHub Pages from the root of `main`. The Lambda Function URL is a separate origin, so this is cross origin and needs CORS.

## How it works

iOS only supports web push for web apps installed to the Home Screen, so:

- On load, check `window.matchMedia('(display-mode: standalone)').matches`. If false and the user agent is iOS, show an install screen with the Share, then Add to Home Screen steps instead of the main UI. Style it to match the mockup.
- The notification permission prompt must fire from a real tap. Never call it on page load.
- Identity is a UUID generated once and kept in `localStorage`, alongside a display name. No SSO, no accounts.

## Data model

One table, `upforbeers`. Partition key `pk` (string), sort key `sk` (string). On demand billing. TTL enabled on attribute `ttl`.

| Item | pk | sk | Attributes |
|---|---|---|---|
| Subscription | `SUB` | sha256 of endpoint | `userId`, `name`, `endpoint`, `p256dh`, `auth`, `createdAt` |
| Active signal | `SIGNAL` | `userId` | `name`, `expiresAt`, `ttl`, `joined` (bool) |
| Cooldown | `COOLDOWN` | `userId` | `lastSent` |

A signal lives 3 hours. Cooldown is 1 hour per person. Put both in a config block at the top of the handler so I can change them in one place.

## API

All routes on one Lambda, dispatched on method and path from the Function URL event.

- `POST /subscribe` with `{ userId, name, subscription }`. Upserts the SUB item. Idempotent.
- `POST /broadcast` with `{ userId, name }`. Acquires the cooldown, writes a SIGNAL, pushes to everyone else.
- `POST /join` with `{ userId, name }`. Writes a SIGNAL with `joined: true`, pushes only to people who already have an active signal. No cooldown on this one.
- `POST /leave` with `{ userId }`. Deletes the SIGNAL. No push.
- `GET /state?userId=...`. Returns the active roster with seconds remaining per person, plus this user's cooldown seconds remaining. This is the only thing the frontend polls.

### Cooldown must be a single atomic conditional write

Do not read then check then write, it races on a double tap. Use one `UpdateItem`:

```
Key:                  { pk: "COOLDOWN", sk: userId }
UpdateExpression:     SET lastSent = :now
ConditionExpression:  attribute_not_exists(lastSent) OR lastSent < :cutoff
```

Where `:cutoff` is now minus the cooldown window. On `ConditionalCheckFailedException`, return 429 with `{ retryAfter: seconds }` and send nothing. The client renders the countdown from the server response, never from localStorage, so clearing storage cannot skip the cooldown.

### Auth

A shared passphrase, sent as an `x-beer-key` header on `/broadcast` and `/join`. The Lambda compares it against an SSM SecureString using `crypto.timingSafeEqual` on equal length buffers. Reject with 401 on mismatch.

The client prompts for the passphrase once, keeps it in localStorage, and re-prompts on a 401. It must never be committed to the repo or baked into the deployed JS as a literal.

### Sending pushes

Use the `web-push` npm package. VAPID private key comes from SSM at cold start, cached in a module level variable across warm invocations. Fetch it with `WithDecryption`.

Two things that will bite otherwise:

1. **Always call `showNotification` in the service worker `push` handler.** iOS revokes permission from web apps that receive a push and display nothing. There is no silent push here.
2. **Prune dead endpoints.** A 404 or 410 from the push service means the app was deleted. Delete that SUB item. Log other status codes and move on. Never let one bad endpoint fail the whole fanout, so use `Promise.allSettled`.

Notification payload: `{ title, body, url }`. Service worker shows it and, on `notificationclick`, focuses an existing window if one is open or opens the app URL if not.

## Repo layout

```
upforbeers/
  CNAME                     # upforbeers.philipknott.net
  .nojekyll
  index.html
  styles.css
  app.js
  sw.js
  manifest.webmanifest
  config.js                 # FUNCTION_URL and VAPID_PUBLIC_KEY, both public values
  icons/                    # 180, 192, 512 png plus source svg
  lambda/
    index.mjs
    package.json
  SETUP.md
  README.md
  .gitignore
```

Generate the icons yourself: write a small SVG mark in the mockup's amber on the dark background, then rasterize it to the three sizes with a script. Nothing elaborate, a pint silhouette or a bold `ub` lockup is fine.

`manifest.webmanifest` needs `"display": "standalone"`, `"name": "upforbeers"`, `"short_name": "upforbeers"`, `"background_color"` and `"theme_color"` matching the mockup's `--ink`, and the icon set. `index.html` needs the `apple-touch-icon` link, since iOS ignores the manifest icons for the Home Screen.

## Deliverable: SETUP.md

This is as important as the code. I am setting the AWS side up by hand and I want to follow it top to bottom without guessing. Write it as numbered steps with copy pasteable commands. Assume `us-west-2`, the AWS CLI already configured, and that I will fill in my own account ID.

Cover, in this order:

1. Creating the GitHub repo and the first push.
2. Generating VAPID keys with `npx web-push generate-vapid-keys`, and which of the two is public.
3. `aws dynamodb create-table` with the schema above, plus `update-time-to-live` for the `ttl` attribute.
4. Putting the VAPID private key and the passphrase into SSM Parameter Store as SecureString at `/upforbeers/vapid-private` and `/upforbeers/passphrase`. Note that standard parameters are free and Secrets Manager is not.
5. Creating the IAM execution role: trust policy for `lambda.amazonaws.com`, the basic execution managed policy, and an inline policy scoped to just this table's ARN and just these two parameter paths, plus `kms:Decrypt` on the default SSM key. No wildcards on resources.
6. Building the Lambda zip (`npm install --omit=dev` in `lambda/`, then zip) and `aws lambda create-function` on the `nodejs22.x` runtime, with a one line update command I can rerun on every change.
7. Creating the Function URL with `--auth-type NONE`, CORS restricted to `https://upforbeers.philipknott.net` only, allowed headers `content-type` and `x-beer-key`. Explain that `AllowOrigins: ["*"]` would let any page on the internet buzz everyone's phone. Include the `add-permission` call for `lambda:InvokeFunctionUrl` that public Function URLs also require.
8. Setting `CloudWatch` log retention to 14 days, since the default is never expire.
9. Filling in `config.js` with the Function URL and the VAPID public key, then pushing.
10. GitHub Pages: the `CNAME` file, the custom domain field in repo settings, and Enforce HTTPS once the cert provisions.
11. Route 53: the CNAME record for `upforbeers` pointing at `filupnot.github.io.` with the trailing dot.
12. Testing on an actual iPhone. Open in Safari, Share, Add to Home Screen, open from the icon, enter name, tap enable, grant permission, then broadcast from a second device.
13. A billing alarm at 5 dollars.

Add a short troubleshooting section at the end: permission prompt does nothing (not in standalone mode), CORS error (origin mismatch or missing header in the allow list), push returns 403 (VAPID keypair mismatch between what the client subscribed with and what the Lambda signs with), and notifications stop after a while (a push arrived without a `showNotification` call).

## Order of work

Do the Lambda first and let me exercise it with curl before you touch the frontend. Then wire the frontend to it. Then write SETUP.md last, once you know what the real resource names and shapes ended up being.
