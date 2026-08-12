import { createHash, timingSafeEqual } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import webpush from 'web-push';

// ---------- config ----------
const CONFIG = {
  table: process.env.TABLE_NAME || 'upforbeers',
  signalTtlSeconds: 3 * 3600, // a signal lives 3 hours
  maxMessageLength: 80, // a note rides along on the push, keep it inside one notification line
  appName: 'UpForBeers',
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:filupnot@gmail.com',
  vapidPrivateParam: '/upforbeers/vapid-private',
  passphraseParam: '/upforbeers/passphrase',
  appUrl: process.env.APP_URL || 'https://upforbeers.philipknott.net',
};

// ---------- clients ----------
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ssm = new SSMClient({});

// ---------- cold start secrets, cached across warm invocations ----------
let secretsPromise;
function loadSecrets() {
  if (!secretsPromise) {
    secretsPromise = Promise.all([
      getParam(CONFIG.vapidPrivateParam),
      getParam(CONFIG.passphraseParam),
    ]).then(([vapidPrivate, passphrase]) => {
      webpush.setVapidDetails(CONFIG.vapidSubject, CONFIG.vapidPublicKey, vapidPrivate);
      return { passphrase };
    });
  }
  return secretsPromise;
}

async function getParam(Name) {
  const out = await ssm.send(new GetParameterCommand({ Name, WithDecryption: true }));
  return out.Parameter.Value;
}

// ---------- helpers ----------
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const now = () => Math.floor(Date.now() / 1000);

// A note is free text from the client. Collapse whitespace so it cannot smuggle
// newlines into the notification body, and cap it so the push payload stays small.
function cleanMessage(m) {
  if (typeof m !== 'string') return '';
  return m.replace(/\s+/g, ' ').trim().slice(0, CONFIG.maxMessageLength);
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function equalSecret(a, b) {
  const ab = Buffer.from(a || '', 'utf8');
  const bb = Buffer.from(b || '', 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ---------- data access ----------
async function activeSignals() {
  const out = await ddb.send(
    new QueryCommand({
      TableName: CONFIG.table,
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': 'SIGNAL' },
    })
  );
  const t = now();
  // TTL deletion can lag, so filter on expiresAt ourselves.
  return (out.Items || []).filter((i) => i.expiresAt > t);
}

async function allSubscriptions() {
  const out = await ddb.send(
    new QueryCommand({
      TableName: CONFIG.table,
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': 'SUB' },
    })
  );
  return out.Items || [];
}

async function pruneSub(sk) {
  await ddb.send(
    new DeleteCommand({ TableName: CONFIG.table, Key: { pk: 'SUB', sk } })
  );
}

// ---------- push fanout ----------
async function fanout(subs, payload) {
  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body
      )
    )
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') continue;
    const code = r.reason?.statusCode;
    if (code === 404 || code === 410) {
      // App was deleted, endpoint is dead. Drop it.
      await pruneSub(subs[i].sk).catch((e) => console.error('prune failed', e));
    } else {
      console.error('push failed', code, r.reason?.body || r.reason?.message);
    }
  }
}

// ---------- routes ----------
async function subscribe(data) {
  const { userId, name, subscription } = data;
  if (!userId || !name || !subscription?.endpoint || !subscription?.keys) {
    return json(400, { error: 'userId, name, subscription required' });
  }
  await ddb.send(
    new PutCommand({
      TableName: CONFIG.table,
      Item: {
        pk: 'SUB',
        sk: sha256(subscription.endpoint),
        userId,
        name,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        createdAt: now(),
      },
    })
  );
  return json(200, { ok: true });
}

async function broadcast(data) {
  const { userId, name } = data;
  if (!userId || !name) return json(400, { error: 'userId and name required' });

  const t = now();
  const message = cleanMessage(data.message);

  await writeSignal(userId, name, false, t, message);

  const subs = (await allSubscriptions()).filter((s) => s.userId !== userId);
  await fanout(subs, {
    title: CONFIG.appName,
    body: message ? `${name} is up for beers: ${message}` : `${name} is up for beers`,
    url: CONFIG.appUrl,
  });

  // Count distinct people notified, not raw endpoints.
  const notified = new Set(subs.map((s) => s.userId)).size;
  return json(200, { ok: true, notified, expiresIn: CONFIG.signalTtlSeconds });
}

async function join(data) {
  const { userId, name } = data;
  if (!userId || !name) return json(400, { error: 'userId and name required' });

  const t = now();
  const message = cleanMessage(data.message);

  // Push only to people who already have an active signal (excluding self).
  const active = await activeSignals();
  const upUserIds = new Set(active.map((s) => s.sk).filter((id) => id !== userId));

  await writeSignal(userId, name, true, t, message);

  let notified = 0;
  if (upUserIds.size) {
    const subs = (await allSubscriptions()).filter((s) => upUserIds.has(s.userId));
    await fanout(subs, {
      title: CONFIG.appName,
      body: message ? `${name} is in: ${message}` : `${name} is in`,
      url: CONFIG.appUrl,
    });
    notified = new Set(subs.map((s) => s.userId)).size;
  }

  return json(200, { ok: true, notified, expiresIn: CONFIG.signalTtlSeconds });
}

async function writeSignal(userId, name, joined, t, message) {
  await ddb.send(
    new PutCommand({
      TableName: CONFIG.table,
      Item: {
        pk: 'SIGNAL',
        sk: userId,
        name,
        expiresAt: t + CONFIG.signalTtlSeconds,
        ttl: t + CONFIG.signalTtlSeconds,
        joined,
        // Empty string is not a useful attribute, drop it rather than store it.
        message: message || undefined,
      },
    })
  );
}

async function leave(data) {
  const { userId } = data;
  if (!userId) return json(400, { error: 'userId required' });
  await ddb.send(
    new DeleteCommand({ TableName: CONFIG.table, Key: { pk: 'SIGNAL', sk: userId } })
  );
  return json(200, { ok: true });
}

async function state(event) {
  const userId = event.queryStringParameters?.userId;
  if (!userId) return json(400, { error: 'userId required' });

  const t = now();
  const active = await activeSignals();
  const roster = active
    .map((s) => ({
      userId: s.sk,
      name: s.name,
      message: s.message || '',
      secondsLeft: Math.max(0, s.expiresAt - t),
      joined: !!s.joined,
      mine: s.sk === userId,
    }))
    .sort((a, b) => b.secondsLeft - a.secondsLeft);

  return json(200, { roster, now: t });
}

// ---------- dispatch ----------
export const handler = async (event) => {
  const secrets = await loadSecrets();

  const method = event.requestContext?.http?.method;
  const path = event.rawPath || '/';

  try {
    if (method === 'GET' && path === '/state') return await state(event);

    if (method === 'POST' && path === '/subscribe') return await subscribe(parseBody(event));
    if (method === 'POST' && path === '/leave') return await leave(parseBody(event));

    // Authenticated routes.
    if (method === 'POST' && (path === '/broadcast' || path === '/join')) {
      const key = event.headers?.['x-beer-key'];
      if (!equalSecret(key, secrets.passphrase)) return json(401, { error: 'bad key' });
      const data = parseBody(event);
      return path === '/broadcast' ? await broadcast(data) : await join(data);
    }

    return json(404, { error: 'not found' });
  } catch (e) {
    console.error('handler error', e);
    return json(500, { error: 'server error' });
  }
};
