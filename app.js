'use strict';

const { FUNCTION_URL, VAPID_PUBLIC_KEY } = window.UB_CONFIG;

const WINDOW = 3 * 3600; // a signal lives 3 hours, matches the Lambda config
const POLL_MS = 5000;

// ---------- identity ----------
function uid() {
  let v = localStorage.getItem('ub_uid');
  if (!v) {
    v = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
    localStorage.setItem('ub_uid', v);
  }
  return v;
}
const USER_ID = uid();
let NAME = localStorage.getItem('ub_name') || '';

// ---------- elements ----------
const phone = document.getElementById('phone');
const fill = document.getElementById('fill');
const label = document.getElementById('label');
const timer = document.getElementById('timer');
const glyph = document.getElementById('glyph');
const status = document.getElementById('status');
const rows = document.getElementById('rows');
const count = document.getElementById('count');
const whoami = document.getElementById('whoami');
const undo = document.getElementById('undo');
const pint = document.getElementById('pint');
const msgField = document.getElementById('msgField');

// ---------- local model, synced from the server ----------
let model = { roster: [] };
let justNotified = null; // count returned by the last broadcast/join, shown while we're up
let busy = false;

// ---------- format ----------
const fmt = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm';
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- derive the display state ----------
function currentState() {
  const mine = model.roster.find((p) => p.mine);
  const others = model.roster.filter((p) => !p.mine);
  if (mine) return 'mine';
  if (others.length) return 'theirs';
  return 'idle';
}

function renderRoster() {
  const list = model.roster;
  count.textContent = list.length ? list.length : '';
  rows.innerHTML = list.length
    ? list
        .map((p) => {
          const who = p.mine ? esc(p.name) + ' (you)' : esc(p.name);
          const note = p.message ? `<span class="rowmsg">${esc(p.message)}</span>` : '';
          return `<div class="row"><span class="pip"></span><span class="who">${who}${note}</span><span class="left">${fmt(p.secondsLeft)} left</span></div>`;
        })
        .join('')
    : '<div class="empty">Nobody yet. Be the one.</div>';
}

function render() {
  const st = currentState();
  phone.className = 'phone is-' + st + (phone.classList.contains('is-onboard') ? ' is-onboard' : '');

  const mine = model.roster.find((p) => p.mine);
  const others = model.roster.filter((p) => !p.mine);

  if (st === 'idle') {
    fill.style.height = '0%';
    phone.style.setProperty('--glow', 0);
    glyph.textContent = '🍺';
    label.textContent = "I'm up for beers";
    timer.textContent = '';
    status.innerHTML = 'Quiet night. Tap to let the group know.';
  } else if (st === 'theirs') {
    fill.style.height = '0%';
    phone.style.setProperty('--glow', 0.85);
    glyph.textContent = '👋';
    label.textContent = "I'm in";
    timer.textContent = '';
    const caller = others.find((p) => !p.joined) || others[0];
    const extra = others.length > 1 ? ` and <b>${others.length - 1}</b> other${others.length > 2 ? 's' : ''}` : '';
    const verb = others.length > 1 ? 'are' : 'is';
    const note = caller.message ? ` &ldquo;${esc(caller.message)}&rdquo;` : '';
    status.innerHTML = `<b>${esc(caller.name)}</b>${extra} ${verb} up for beers${note}. Tap to join and they'll know.`;
  } else if (st === 'mine') {
    fill.style.height = Math.max(0, (mine.secondsLeft / WINDOW) * 100) + '%';
    phone.style.setProperty('--glow', 1);
    glyph.textContent = '🍺';
    label.textContent = "You're up";
    timer.textContent = fmt(mine.secondsLeft) + ' left';
    if (justNotified != null) {
      status.innerHTML = `<b>${justNotified} friend${justNotified === 1 ? '' : 's'}</b> just got a notification.`;
    } else if (others.length) {
      status.innerHTML = `<b>${others.length}</b> other${others.length === 1 ? '' : 's'} in so far.`;
    } else {
      status.innerHTML = "You're up for beers. Waiting on the crew.";
    }
  }

  renderRoster();
}

// ---------- server ----------
async function fetchState() {
  try {
    const r = await fetch(`${FUNCTION_URL}/state?userId=${encodeURIComponent(USER_ID)}`);
    if (!r.ok) return;
    const data = await r.json();
    model.roster = data.roster || [];
    if (!model.roster.some((p) => p.mine)) justNotified = null;
    render();
  } catch (e) {
    console.error('state fetch failed', e);
  }
}

// ---------- passphrase gate ----------
const gate = document.getElementById('gate');
const keyField = document.getElementById('keyField');
const keyBtn = document.getElementById('keyBtn');
const keyHint = document.getElementById('keyHint');
let keyResolver = null;

function askKey(reprompt) {
  keyHint.textContent = reprompt ? 'That passphrase did not match. Try again.' : 'Kept only on this device.';
  keyHint.classList.toggle('error', !!reprompt);
  keyField.value = '';
  gate.classList.add('show');
  setTimeout(() => keyField.focus(), 50);
  return new Promise((resolve) => {
    keyResolver = resolve;
  });
}
function submitKey() {
  const v = keyField.value.trim();
  if (!v) return;
  localStorage.setItem('ub_key', v);
  gate.classList.remove('show');
  const r = keyResolver;
  keyResolver = null;
  if (r) r(v);
}
keyBtn.onclick = submitKey;
keyField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitKey();
});

async function getKey(reprompt) {
  const stored = localStorage.getItem('ub_key');
  if (stored && !reprompt) return stored;
  return askKey(reprompt);
}

// ---------- push subscription ----------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let swReg = null;
async function ensureSubscribed() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    status.textContent = 'This browser cannot receive push notifications.';
    return false;
  }
  if (!swReg) swReg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;

  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      status.textContent = 'Notifications are off, so you would not hear the buzz. Enable them in Settings.';
      return false;
    }
  }
  if (Notification.permission !== 'granted') {
    status.textContent = 'Notifications are blocked. Enable them for upforbeers in Settings.';
    return false;
  }

  let sub = await swReg.pushManager.getSubscription();
  if (!sub) {
    sub = await swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  const r = await fetch(`${FUNCTION_URL}/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: USER_ID, name: NAME, subscription: sub.toJSON() }),
  });
  return r.ok;
}

// ---------- actions ----------
async function post(path, needsKey, extra) {
  let reprompt = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { 'content-type': 'application/json' };
    if (needsKey) headers['x-beer-key'] = await getKey(reprompt);
    const r = await fetch(`${FUNCTION_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: USER_ID, name: NAME, ...extra }),
    });
    if (r.status === 401 && needsKey) {
      localStorage.removeItem('ub_key');
      reprompt = true;
      continue;
    }
    return r;
  }
  return null;
}

// The note is only read at send time, so it never needs to live in the model.
function takeMessage() {
  return msgField.value.trim();
}

async function broadcast() {
  if (!(await ensureSubscribed())) return;
  const r = await post('/broadcast', true, { message: takeMessage() });
  if (!r) return;
  if (r.ok) {
    msgField.value = '';
    const data = await r.json().catch(() => ({}));
    justNotified = data.notified ?? null;
  }
  await fetchState();
}

async function join() {
  if (!(await ensureSubscribed())) return;
  const r = await post('/join', true, { message: takeMessage() });
  if (r && r.ok) {
    msgField.value = '';
    const data = await r.json().catch(() => ({}));
    justNotified = data.notified ?? null;
  }
  await fetchState();
}

async function leave() {
  justNotified = null;
  await fetch(`${FUNCTION_URL}/leave`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: USER_ID }),
  }).catch((e) => console.error('leave failed', e));
  await fetchState();
}

pint.onclick = async () => {
  if (busy) return;
  const st = currentState();
  if (st === 'mine') return;
  busy = true;
  pint.disabled = true;
  try {
    if (st === 'idle') await broadcast();
    else if (st === 'theirs') await join();
  } finally {
    busy = false;
    pint.disabled = false;
  }
};
undo.onclick = () => leave();
msgField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    msgField.blur(); // drop the mobile keyboard so the confirmation is visible
    pint.click();
  }
});

// ---------- onboarding ----------
const nameField = document.getElementById('nameField');
const goBtn = document.getElementById('goBtn');

function setName(n) {
  NAME = n;
  localStorage.setItem('ub_name', n);
  whoami.textContent = n;
}
whoami.onclick = () => {
  const n = prompt('What should we call you?', NAME);
  if (n && n.trim()) {
    setName(n.trim());
    ensureSubscribed().catch(() => {}); // refresh the stored name on the subscription
  }
};

function finishOnboard() {
  const n = nameField.value.trim();
  if (!n) return;
  setName(n);
  phone.classList.remove('is-onboard');
  render();
  fetchState();
}
goBtn.onclick = finishOnboard;
nameField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') finishOnboard();
});

// ---------- boot ----------
function isIOS() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function boot() {
  if (isIOS() && !isStandalone()) {
    document.body.classList.add('needs-install');
    return;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      swReg = reg;
    }).catch((e) => console.error('sw register failed', e));
  }

  if (!NAME) {
    phone.classList.add('is-onboard');
  } else {
    whoami.textContent = NAME;
  }

  render();
  fetchState();

  // Local one second tick keeps the timers alive between polls.
  setInterval(() => {
    let changed = false;
    for (const p of model.roster) {
      if (p.secondsLeft > 0) {
        p.secondsLeft -= 1;
        changed = true;
      }
    }
    if (changed) render();
  }, 1000);

  setInterval(fetchState, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchState();
  });
}

boot();
