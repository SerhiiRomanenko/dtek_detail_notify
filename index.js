import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, open, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ZONE = 'Europe/Kyiv';
const RAW = 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main';
const MINUTE = 60_000;
const HALF = 30 * MINUTE;
const STATES = Object.freeze({
  yes: ['ON', 'ON'], no: ['OFF', 'OFF'], maybe: ['MAYBE', 'MAYBE'],
  first: ['OFF', 'ON'], second: ['ON', 'OFF'],
  mfirst: ['MAYBE', 'ON'], msecond: ['ON', 'MAYBE'],
});
const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
export function clockParts(ms) {
  return Object.fromEntries(partsFormat.formatToParts(ms).map(p => [p.type, p.value]));
}
export function dateKey(ms) {
  const p = clockParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}
export function timeLabel(ms) {
  const p = clockParts(ms);
  return `${p.hour}:${p.minute}`;
}
export function log(message) {
  const now = Date.now();
  console.log(`[${dateKey(now)} ${timeLabel(now)}:${clockParts(now).second}] ${message}`);
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sorted = values => [...values].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

export function config(env = process.env, requireTelegram = true) {
  const integer = (key, fallback, min, max) => {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
      throw new Error(`${key}: очікується ціле число ${min}–${max}`);
    }
    return Number(raw);
  };
  const token = env.TELEGRAM_BOT_TOKEN || '';
  const chat = env.TELEGRAM_CHAT_ID || '';
  if (requireTelegram && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Некоректний TELEGRAM_BOT_TOKEN');
  if (requireTelegram && !/^-100\d+$/.test(chat) && !/^@[A-Za-z0-9_]{5,}$/.test(chat)) {
    throw new Error('TELEGRAM_CHAT_ID має вигляд -100xxxxxxxxxx або @username (щонайменше 5 літер, цифр чи підкреслень)');
  }
  const region = env.REGION || 'kyiv-region';
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(region)) throw new Error('Некоректний REGION');
  const first = env.POST_ON_FIRST_RUN ?? 'false';
  if (!['true', 'false'].includes(first)) throw new Error('POST_ON_FIRST_RUN: true або false');
  const redisUrl = env.UPSTASH_REDIS_REST_URL?.trim() || '';
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN?.trim() || '';
  if (Boolean(redisUrl) !== Boolean(redisToken)) throw new Error('Потрібні обидві UPSTASH_REDIS_REST_URL та UPSTASH_REDIS_REST_TOKEN');
  if (redisUrl) {
    let url;
    try { url = new URL(redisUrl); } catch { throw new Error('Некоректний UPSTASH_REDIS_REST_URL'); }
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.upstash.io') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('UPSTASH_REDIS_REST_URL: потрібен HTTPS endpoint *.upstash.io без додаткового шляху');
    }
  }
  return {
    token, chat, region, first: first === 'true',
    redisUrl, redisToken,
    interval: integer('CHECK_INTERVAL_SECONDS', 60, 1, 3600) * 1000,
    before: integer('NOTIFY_BEFORE_MINUTES', 30, 1, 1440) * MINUTE,
    timeout: integer('HTTP_TIMEOUT_SECONDS', 20, 1, 120) * 1000,
    attempts: integer('RETRY_ATTEMPTS', 4, 1, 10),
    retryBase: integer('RETRY_BASE_MS', 1000, 1, 60_000),
    stateFile: path.resolve(env.STATE_FILE || './state.json'),
  };
}

// Use the JSON's explicit hour mapping, never infer OFF from an unknown value.
export function normalize(raw, region, warn = log) {
  if (!object(raw) || raw.regionId !== region) throw new Error('JSON: regionId не збігається');
  if (raw.lastUpdateStatus?.ok !== true) throw new Error('Джерело не підтвердило успішне оновлення');
  if (!object(raw.fact?.data) || !object(raw.preset?.time_zone)) throw new Error('JSON: немає fact.data / preset.time_zone');
  const hourKeys = new Map();
  for (const [key, labels] of Object.entries(raw.preset.time_zone)) {
    if (!Array.isArray(labels) || !/^\d{2}:00$/.test(labels[1]) || !/^\d{2}:00$/.test(labels[2])) {
      throw new Error('Непідтримувана структура preset.time_zone');
    }
    const start = Number(labels[1].slice(0, 2));
    const end = Number(labels[2].slice(0, 2));
    if (start < 0 || start > 23 || end !== start + 1 || hourKeys.has(start)) throw new Error('Некоректні годинні слоти');
    hourKeys.set(start, key);
  }
  if (hourKeys.size !== 24) throw new Error('Очікується 24 годинні слоти');
  const today = Number(raw.fact.today) * 1000;
  if (!Number.isSafeInteger(today) || today < 0 || timeLabel(today) !== '00:00') throw new Error('Некоректний fact.today');
  const days = [];
  const unknown = new Set();
  for (const epoch of Object.keys(raw.fact.data).sort((a, b) => Number(a) - Number(b))) {
    const start = Number(epoch) * 1000;
    if (!/^\d{10}$/.test(epoch) || timeLabel(start) !== '00:00') throw new Error('Некоректна дата fact.data');
    const source = raw.fact.data[epoch];
    if (!object(source)) throw new Error('Некоректний день fact.data');
    // Empty tomorrow is a legitimate unpublished schedule, not an ON day.
    if (!Object.keys(source).length) continue;
    const date = dateKey(start);
    let end = start + HALF;
    while (dateKey(end) === date && end - start <= 26 * 60 * MINUTE) end += HALF;
    const groups = {};
    for (const group of sorted(Object.keys(source))) {
      if (!/^GPV\d+\.\d+$/.test(group)) { warn(`Unknown group: ${group}; skipped`); continue; }
      const slots = source[group];
      if (!object(slots)) throw new Error(`Некоректні слоти ${group}`);
      for (const key of hourKeys.values()) {
        if (typeof slots[key] !== 'string') throw new Error(`Відсутній слот ${group}/${key}`);
        if (!Object.hasOwn(STATES, slots[key])) unknown.add(slots[key]);
      }
      groups[group] = [];
      // Walk real instants: Kyiv's DST days can have 46 or 50 half-hours.
      for (let at = start; at < end; at += HALF) {
        const p = clockParts(at);
        const state = STATES[slots[hourKeys.get(Number(p.hour))]]?.[Number(p.minute) >= 30 ? 1 : 0] ?? 'UNKNOWN';
        groups[group].push([at, state]);
      }
    }
    if (!Object.keys(groups).length) throw new Error('Немає відомих груп');
    days.push({ date, start, end, groups });
  }
  if (unknown.size) {
    warn(`Unknown slot states: ${sorted(unknown).join(', ')}; snapshot rejected`);
    throw new Error('Невідомі стани: збережено попередній графік');
  }
  if (!days.length || !days.some(d => d.start === today)) throw new Error('Немає валідного графіка fact.today');
  const dayHashes = Object.fromEntries(days.map(d => [d.date, hash(d)]));
  return {
    hash: hash(days), dayHashes, days, today,
    source: { update: raw.fact.updateFact || raw.fact.update || null,
      lastUpdated: raw.lastUpdated ?? null, contentHash: raw.meta?.contentHash ?? null },
  };
}

export function transitions(schedule) {
  const byGroup = new Map();
  for (const day of schedule.days) for (const [group, slots] of Object.entries(day.groups)) {
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(...slots);
  }
  const events = [];
  for (const [group, slots] of byGroup) {
    slots.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < slots.length; i++) {
      const [at, to] = slots[i];
      const [prevAt, from] = slots[i - 1];
      if (at - prevAt !== HALF || to === from || [to, from].includes('UNKNOWN')) continue;
      const kind = to === 'ON' && from === 'MAYBE' ? 'CLEAR' : to;
      events.push({ at, group, kind, from, to, id: `${at}|${kind}|${group}` });
    }
  }
  return events.sort((a, b) => a.at - b.at || a.group.localeCompare(b.group, 'en', { numeric: true }));
}

export function warning(events, now, urgent) {
  const at = events[0].at;
  const minutes = Math.max(1, Math.ceil((at - now) / MINUTE));
  const sections = {
    OFF: group => `🪫 Вимикатимуть ${group} групу`,
    ON: group => `🔋 Вмикатимуть ${group} групу`,
    MAYBE: group => `🟡 Можуть вимикати ${group} групу`,
    CLEAR: group => `🟡 Завершиться період можливих відключень для ${group} групи`,
  };
  const lines = [`⚡️<b>💡 О ${timeLabel(at)} ㅤ</b>`, ''];
  if (urgent) lines.unshift('⚠️ Термінова зміна графіка');
  for (const [kind, format] of Object.entries(sections)) {
    const groups = events.filter(e => e.kind === kind).map(e => e.group.replace(/^GPV/, ''));
    lines.push(...sorted(groups).map(format));
  }
  if (urgent) lines.push(`До зміни залишилося близько ${minutes} хвилин.`);
  return lines.join('\n');
}

export class StateError extends Error {}
const emptyState = (region, chat) => ({ version: 1, region, chat, schedule: null, sent: {}, urgent: {}, photos: {} });
function validateState(state, region, chat) {
  if (!object(state) || state.version !== 1 || state.region !== region || state.chat !== chat || !object(state.sent) || !object(state.photos) || !object(state.urgent) ||
      (state.schedule !== null && (!Array.isArray(state.schedule?.days) || hash(state.schedule.days) !== state.schedule.hash))) {
    throw new StateError('Некоректний state або інший REGION/CHAT; стан не буде перезаписано');
  }
  return state;
}
export class StateStore {
  constructor(filename) { this.filename = filename; this.lockFile = `${filename}.lock`; }
  async lock() {
    await mkdir(path.dirname(this.filename), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.lockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
        await handle.close();
        this.locked = true;
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let pid;
        try { pid = JSON.parse(await readFile(this.lockFile, 'utf8')).pid; } catch { throw new Error(`Перевірте lock вручну: ${this.lockFile}`); }
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('Некоректний lock PID');
        try { process.kill(pid, 0); throw new Error('Інший екземпляр бота вже працює'); }
        catch (err) { if (err.code !== 'ESRCH') throw err; }
        await unlink(this.lockFile);
      }
    }
    throw new Error('Не вдалося захопити lock');
  }
  async unlock() { if (this.locked) { await unlink(this.lockFile); this.locked = false; } }
  async read(region, chat) {
    let state;
    try { state = JSON.parse(await readFile(this.filename, 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') return emptyState(region, chat);
      throw new StateError('Не вдалося прочитати state.json; файл не буде перезаписано');
    }
    return validateState(state, region, chat);
  }
  async write(state) {
    const temp = `${this.filename}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, this.filename);
      // Windows does not allow opening a directory for fsync.
      if (process.platform !== 'win32') {
        const directory = await open(path.dirname(this.filename), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch {
      await unlink(temp).catch(() => {});
      throw new StateError('Atomic state write failed; stopping to avoid duplicate publications');
    }
  }
}

// Lua keeps ownership checks and writes atomic. Both keys share a Redis hash tag.
export const REDIS_SCRIPTS = {
  acquire: `local owner = redis.call('GET', KEYS[1])
if owner and owner ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]); return 1`,
  renew: `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2]); return 1`,
  release: `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`,
  read: `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {0} end
return {1, redis.call('GET', KEYS[2])}`, 
  write: `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2]);
if tonumber(ARGV[3]) > 0 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
return 1`,
};

export class RedisStateStore {
  constructor(cfg, { command, logger = log, namespace = '', stateTtl = 0 } = {}) {
    this.cfg = cfg;
    this.logger = logger;
    const identity = hash([cfg.region, cfg.chat.toLowerCase()]);
    this.key = `outage-bot:{${identity}}${namespace}:state`;
    this.lockKey = `outage-bot:{${identity}}${namespace}:lock`;
    this.owner = randomUUID();
    this.leaseMs = 180_000;
    this.stateTtl = stateTtl; // Only diagnostics use expiration; production state never expires.
    this.commandFn = command;
  }
  async command(args) {
    try {
      if (this.commandFn) return await this.commandFn(args);
      const response = await request(this.cfg.redisUrl, {
        cfg: this.cfg, logger: this.logger,
        build: () => ({ method: 'POST', headers: { Authorization: `Bearer ${this.cfg.redisToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) }),
      });
      if (!object(response) || response.error || !Object.hasOwn(response, 'result')) throw new Error('Invalid Redis response');
      return response.result;
    } catch (error) {
      // Never include a remote error, URL, token or state payload in logs.
      const detail = error instanceof HttpError ? ` (${error.message})` : '';
      throw new StateError(`Upstash Redis недоступний або відхилив команду${detail}; публікації зупинено`);
    }
  }
  async eval(script, keys, args) {
    return this.command(['EVAL', script, keys.length, ...keys, ...args]);
  }
  async lock() {
    if (await this.eval(REDIS_SCRIPTS.acquire, [this.lockKey], [this.owner, this.leaseMs]) !== 1) {
      throw new StateError('Інший екземпляр бота вже володіє Redis lock; повторіть запуск пізніше');
    }
    this.locked = true;
    this.scheduleRenewal();
  }
  scheduleRenewal() {
    if (!this.locked || this.lost) return;
    this.timer = setTimeout(() => {
      this.renewal = this.assertOwner().catch(() => {
        this.lost = true;
        this.logger('Redis lock lost; publications stopped');
      }).finally(() => this.scheduleRenewal());
    }, this.leaseMs / 3);
    this.timer.unref();
  }
  async assertOwner() {
    if (!this.locked || this.lost) throw new StateError('Redis lock втрачено; потрібен перезапуск');
    try {
      if (await this.eval(REDIS_SCRIPTS.renew, [this.lockKey], [this.owner, this.leaseMs]) !== 1) throw new StateError('Redis lock втрачено');
    } catch (e) { this.lost = true; throw e; }
  }
  async readExisting(region, chat) {
    await this.assertOwner();
    const result = await this.eval(REDIS_SCRIPTS.read, [this.lockKey, this.key], [this.owner]);
    if (!Array.isArray(result) || result[0] !== 1) { this.lost = true; throw new StateError('Redis lock втрачено'); }
    if (result[1] === null || result[1] === false) return null;
    let state;
    try { state = JSON.parse(result[1]); } catch { throw new StateError('Пошкоджений Redis state; перезапис заборонено'); }
    return validateState(state, region, chat);
  }
  async read(region, chat) { return await this.readExisting(region, chat) ?? emptyState(region, chat); }
  async write(state) {
    validateState(state, this.cfg.region, this.cfg.chat);
    await this.assertOwner();
    if (await this.eval(REDIS_SCRIPTS.write, [this.lockKey, this.key], [this.owner, JSON.stringify(state), this.stateTtl]) !== 1) {
      this.lost = true;
      throw new StateError('Redis lock втрачено; запис стану заборонено');
    }
  }
  async unlock() {
    this.locked = false;
    clearTimeout(this.timer);
    await this.renewal;
    // Only delete this owner's lock. A failed release expires automatically after 180 seconds.
    await this.eval(REDIS_SCRIPTS.release, [this.lockKey], [this.owner]);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class HttpError extends Error {
  constructor(message, retryable, delay = 0) { super(message); this.retryable = retryable; this.delay = delay; }
}
export async function request(url, {
  cfg, build = () => ({}), binary = false, telegram = false, fetchFn = fetch,
  wait = sleep, logger = log, deadline = Infinity, now = Date.now, beforeAttempt = async () => {},
}) {
  for (let attempt = 0; attempt < cfg.attempts; attempt++) {
    await beforeAttempt();
    if (now() >= deadline) throw new HttpError('Подія вже почалася; відправлення скасовано', false);
    try {
      const response = await fetchFn(url, { ...build(), signal: AbortSignal.timeout(Math.min(cfg.timeout, Math.max(1, deadline - now()))) });
      const chunks = [];
      let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length;
        if (size > (binary ? 10_000_000 : 5_000_000)) throw new HttpError('HTTP response too large', false);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      let json;
      if (!binary || !response.ok) {
        try { json = JSON.parse(bytes.toString('utf8')); }
        catch { if (response.ok) throw new HttpError('Invalid JSON response', true); }
      }
      const code = telegram ? (json?.error_code || response.status) : response.status;
      if (!response.ok || (telegram && json?.ok !== true)) {
        const retryAfter = Number(json?.parameters?.retry_after || response.headers.get('retry-after') || 0);
        throw new HttpError(`HTTP/API ${code}`, code === 429 || code >= 500,
          Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : 0);
      }
      return binary ? bytes : json;
    } catch (error) {
      // Do not print fetch errors containing the bot token in the URL.
      const err = error instanceof HttpError ? error : new HttpError(`Network error (${error.name || 'Error'})`, true);
      if (err.delay > 0) err.cooldownUntil = now() + err.delay;
      if (!err.retryable || attempt + 1 >= cfg.attempts) throw err;
      const delay = Math.max(err.delay, Math.min(30_000, cfg.retryBase * 2 ** attempt) + Math.floor(Math.random() * cfg.retryBase));
      if (now() + delay >= deadline) {
        const expired = new HttpError('Повтор запиту вийде за час події; скасовано', false);
        expired.cooldownUntil = err.cooldownUntil;
        throw expired;
      }
      // Long retry_after is deferred to the next cycle without violating Telegram's cooldown.
      if (delay > 60_000) { err.cooldownUntil = now() + delay; throw err; }
      logger(`${err.message}; retry ${attempt + 2}/${cfg.attempts} in ${delay} ms`);
      await wait(delay);
    }
  }
}

export class Transport {
  constructor(cfg, logger = log) { this.cfg = cfg; this.logger = logger; }
  async json() {
    return request(`${RAW}/data/${this.cfg.region}.json?poll=${Date.now()}`, { cfg: this.cfg, logger: this.logger });
  }
  async api(method, build, deadline = Infinity) {
    return request(`https://api.telegram.org/bot${this.cfg.token}/${method}`,
      { cfg: this.cfg, logger: this.logger, telegram: true, build, deadline, beforeAttempt: () => this.beforeSend?.() });
  }
  async message(text, deadline) {
    if (text.length > 4096) throw new Error('Повідомлення перевищує Telegram limit');
    await this.api('sendMessage', () => ({ method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.cfg.chat, text, parse_mode: 'HTML' }) }), deadline);
  }
  async photo(day, schedule) {
    const suffix = day.start === schedule.today ? 'today' : 'tomorrow';
    this.logger(`Downloading updated PNG: gpv-all-${suffix}.png`);
    const bytes = await request(`${RAW}/images/${this.cfg.region}/gpv-all-${suffix}.png?v=${encodeURIComponent(schedule.source.contentHash || schedule.hash)}&t=${Date.now()}`,
      { cfg: this.cfg, logger: this.logger, binary: true });
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid PNG response');
    // The upstream workflow commits data and images together. Detect a branch change during downloads.
    const latest = normalize(await this.json(), this.cfg.region, this.logger);
    if (latest.hash !== schedule.hash || latest.today !== schedule.today || latest.source.contentHash !== schedule.source.contentHash || latest.source.lastUpdated !== schedule.source.lastUpdated) {
      throw new Error('Джерело змінилося під час завантаження PNG; повтор у наступному циклі');
    }
    const date = new Intl.DateTimeFormat('uk-UA', { timeZone: ZONE, day: 'numeric', month: 'long', year: 'numeric' }).format(day.start);
    const caption = `⚡ Оновлено графік відключень\n\n📅 ${date}\n🕐 Оновлення джерела: ${schedule.source.update || 'не вказано'}\n\nДжерело: outage-data-ua. Час за графіком, фактичне живлення може відрізнятися.`;
    await this.api('sendPhoto', () => {
      const form = new FormData();
      form.set('chat_id', this.cfg.chat);
      form.set('caption', caption);
      form.set('photo', new Blob([bytes], { type: 'image/png' }), `gpv-all-${suffix}.png`);
      return { method: 'POST', body: form };
    });
  }
}

export class Monitor {
  constructor({ cfg, state, store, transport, now = Date.now, logger = log, shouldStop = () => false }) {
    Object.assign(this, { cfg, state, store, transport, now, logger, shouldStop });
  }
  async cycle(raw) {
    const schedule = normalize(raw, this.cfg.region, this.logger);
    const now = this.now();
    if (!schedule.days.some(d => now >= d.start && now < d.end)) throw new Error('Дані за поточний день відсутні; публікації призупинено');
    const old = this.state.schedule;
    const events = transitions(schedule);
    const changed = !old || old.hash !== schedule.hash;
    if (changed) {
      this.logger(old ? 'Schedule changed' : 'Creating baseline');
      const oldEvents = new Set(old ? transitions(old).map(e => e.id) : []);
      // Preserve pending urgent intent across failed PNG/text attempts and process restarts.
      this.state.urgent = Object.fromEntries(events.filter(e => this.state.urgent[e.id] ||
        (old && !oldEvents.has(e.id) && e.at > now && e.at - now < this.cfg.before)).map(e => [e.id, e.at]));
      if (!old && !this.cfg.first) {
        for (const day of schedule.days) this.state.photos[day.date] = schedule.dayHashes[day.date];
      }
      this.state.schedule = schedule;
      await this.store.write(this.state);
    } else this.logger('No schedule changes');
    // Even unchanged content can acquire new metadata; use the fresh source for PNG consistency checks.
    this.state.schedule = schedule;
    for (const [id, at] of Object.entries(this.state.sent)) if (at < now - 3 * 86400_000) delete this.state.sent[id];
    for (const [id, at] of Object.entries(this.state.urgent)) if (at <= now) delete this.state.urgent[id];
    for (const date of Object.keys(this.state.photos)) if (date < dateKey(now - 3 * 86400_000)) delete this.state.photos[date];
    if (this.state.cooldownUntil > now) { this.logger('Telegram cooldown active'); return; }
    try {
      const next = schedule.days.find(d => d.start > schedule.today);
      for (const day of schedule.days) {
        if (this.shouldStop()) return;
        if (day.end <= this.now() || (day.start !== schedule.today && day !== next)) continue;
        if (this.state.photos[day.date] === schedule.dayHashes[day.date]) continue;
        await this.transport.photo(day, schedule);
        this.state.photos[day.date] = schedule.dayHashes[day.date];
        await this.store.write(this.state);
        this.logger(`Schedule image published: ${day.date}`);
      }
      const batches = new Map();
      for (const event of events) {
        const remaining = event.at - this.now();
        if (remaining <= 0 || remaining > this.cfg.before || this.state.sent[event.id]) continue;
        if (!batches.has(event.at)) batches.set(event.at, []);
        batches.get(event.at).push(event);
      }
      for (const [at, batch] of batches) {
        if (this.shouldStop()) return;
        if (at <= this.now()) continue;
        const urgent = batch.some(e => this.state.urgent[e.id]);
        this.logger(`Sending ${urgent ? 'urgent' : 'scheduled'} warning: ${batch.map(e => `${e.kind} ${e.group}`).join(', ')}`);
        await this.transport.message(warning(batch, this.now(), urgent), at);
        for (const event of batch) { this.state.sent[event.id] = at; delete this.state.urgent[event.id]; }
        await this.store.write(this.state);
        this.logger('Telegram message sent');
      }
      await this.store.write(this.state);
    } catch (error) {
      if (error.cooldownUntil) { this.state.cooldownUntil = error.cooldownUntil; await this.store.write(this.state); }
      throw error;
    }
  }
}

async function main() {
  if (typeof process.loadEnvFile !== 'function') throw new Error('Потрібен Node.js 20.12+ (рекомендовано 24 LTS)');
  try { process.loadEnvFile(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const inspect = process.argv.includes('--inspect-schedule');
  const cfg = config(process.env, !inspect);
  createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running');
}).listen(process.env.PORT || 10000, '0.0.0.0');
  const transport = new Transport(cfg);
  if (process.argv.includes('--check-redis')) {
    if (!cfg.redisUrl) throw new Error('Налаштуйте UPSTASH_REDIS_REST_URL та UPSTASH_REDIS_REST_TOKEN');
    const probe = new RedisStateStore(cfg, { namespace: `:check:${randomUUID()}`, stateTtl: 300 });
    await probe.lock();
    try {
      const state = emptyState(cfg.region, cfg.chat);
      await probe.write(state);
      if (JSON.stringify(await probe.read(cfg.region, cfg.chat)) !== JSON.stringify(state)) throw new StateError('Redis read/write mismatch');
      log('Redis check passed: lock, atomic write, read. Temporary state expires in 5 minutes. No Telegram messages sent.');
    } finally { await probe.unlock(); }
    return;
  }
  if (process.argv.includes('--migrate-state')) {
    if (!cfg.redisUrl) throw new Error('Налаштуйте Upstash Redis перед міграцією');
    const local = new StateStore(cfg.stateFile);
    await local.lock();
    try {
      // Unlike normal startup, a missing local state must not silently create an empty migration.
      await readFile(cfg.stateFile, 'utf8');
      const state = await local.read(cfg.region, cfg.chat);
      const remote = new RedisStateStore(cfg);
      await remote.lock();
      try {
        if (await remote.readExisting(cfg.region, cfg.chat) !== null) throw new StateError('Redis уже має стан; міграція не перезаписує його');
        await remote.write(state);
        log('Local state migrated to Redis; local file preserved. No Telegram messages sent.');
      } finally { await remote.unlock(); }
    } finally { await local.unlock(); }
    return;
  }
  if (inspect) {
    const fileIndex = process.argv.indexOf('--file');
    const raw = fileIndex >= 0 ? JSON.parse(await readFile(process.argv[fileIndex + 1], 'utf8')) : await transport.json();
    const schedule = normalize(raw, cfg.region);
    console.log(JSON.stringify({ hash: schedule.hash, source: schedule.source,
      days: schedule.days.map(d => ({ date: d.date, groups: Object.keys(d.groups).length })),
      transitions: transitions(schedule).map(e => ({ ...e, local: `${dateKey(e.at)} ${timeLabel(e.at)}` })) }, null, 2));
    return;
  }
  const store = cfg.redisUrl ? new RedisStateStore(cfg) : new StateStore(cfg.stateFile);
  transport.beforeSend = () => store.assertOwner?.();
  await store.lock();
  let stopping = false;
  let wake;
  const stop = () => { stopping = true; log('Shutdown requested; finishing current operation'); wake?.(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const state = await store.read(cfg.region, cfg.chat);
    await store.write(state); // Verify storage writes before any Telegram request.
    const monitor = new Monitor({ cfg, state, store, transport, shouldStop: () => stopping });
    log(`Monitoring ${cfg.region}; interval=${cfg.interval / 1000}s; timezone=${ZONE}; storage=${cfg.redisUrl ? 'Upstash Redis' : 'local file'}`);
    while (!stopping) {
      const started = Date.now();
      try {
        await store.assertOwner?.();
        log('Checking schedule...');
        const raw = await transport.json();
        if (!stopping) await monitor.cycle(raw);
      }
      catch (e) { if (e instanceof StateError) throw e; log(`Cycle failed: ${e.message}`); }
      if (!stopping) await new Promise(resolve => {
        const timer = setTimeout(resolve, Math.max(1000, cfg.interval - (Date.now() - started)));
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await store.unlock();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { log(`Fatal: ${error.message}`); process.exitCode = 1; });
}
