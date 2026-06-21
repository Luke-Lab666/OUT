const $ = {
  arg: parseArgument(typeof $argument !== "undefined" ? $argument : ""),
  domain: typeof $domain !== "undefined" ? $domain : "",
};

const DEFAULT_DOH = "https://8.8.4.4/dns-query";
const DEFAULT_TTL = toInt($.arg.ttl, 60);
const MIN_TTL = toInt($.arg.min_ttl, 1);
const MAX_TTL = toInt($.arg.max_ttl, 600);
const TIMEOUT = toFloat($.arg.timeout, 2);
const MAX_DOH = toInt($.arg.max_doh || $.arg.race, 2);
const HARD_CAP = Math.max(1, toInt($.arg.hard_cap, 4));
const STAGGER = Math.max(0, toInt($.arg.stagger, 120));
const COOLDOWN = Math.max(0, toInt($.arg.cooldown, 60)) * 1000;
const FAIL_LIMIT = Math.max(1, toInt($.arg.fail_limit, 2));
const STATE_TTL = Math.max(60, toInt($.arg.state_ttl, 86400)) * 1000;
const FALLBACK = String($.arg.fallback || "0") === "1";
const LOG = String($.arg.log || "0") === "1";
const STORE_KEY = "DNSLite.Health.v3";

const now = Date.now();
const state = loadState();

(async () => {
  if (!$.domain) return done({});

  const dohList = getDohList($.arg.doh || DEFAULT_DOH);
  if (dohList.length === 0) throw new Error("No valid DoH server");

  const edns = getEDNS();
  const type = String($.arg.type || "dual").toLowerCase();

  log(`[${$.domain}] type=${type}, doh=${dohList.join(",")}, edns=${edns || "off"}`);

  let result;

  if (type === "a" || type === "v4-only") {
    result = await resolveFast(dohList, ["A"], edns);
  } else if (type === "aaaa" || type === "v6-only") {
    result = await resolveFast(dohList, ["AAAA"], edns);
  } else if (type === "prefer-v4") {
    try {
      result = await resolveFast(dohList, ["A"], edns);
    } catch (e) {
      log(`[${$.domain}] prefer-v4 fallback to AAAA: ${messageOf(e)}`);
      result = await resolveFast(dohList, ["AAAA"], edns);
    }
  } else if (type === "prefer-v6") {
    try {
      result = await resolveFast(dohList, ["AAAA"], edns);
    } catch (e) {
      log(`[${$.domain}] prefer-v6 fallback to A: ${messageOf(e)}`);
      result = await resolveFast(dohList, ["A"], edns);
    }
  } else {
    result = await resolveFast(dohList, ["A", "AAAA"], edns);
  }

  const addresses = unique(result.addresses);
  if (addresses.length === 0) throw new Error("Empty DNS answer");

  log(`[${$.domain}] from=${result.url}, rtt=${result.rtt}ms, ttl=${result.ttl}, addresses=${addresses.join(",")}`);

  done({
    addresses,
    ttl: result.ttl,
  });
})().catch((e) => {
  log(`[${$.domain}] failed: ${messageOf(e)}`);
  done(FALLBACK ? {} : { addresses: [], ttl: DEFAULT_TTL });
});

async function resolveFast(dohList, types, edns) {
  const urls = pickDohs(dohList);
  if (urls.length === 0) throw new Error("No DoH server selected");

  log(`[${$.domain}] selected=${urls.join(",")}`);

  const tasks = urls.map((url) => () => queryOneDoh(url, types, edns));
  return firstFulfilledStaggered(tasks, STAGGER);
}

async function queryOneDoh(url, types, edns) {
  const started = Date.now();

  try {
    const results = await Promise.all(types.map((type) => query(url, $.domain, type, edns)));
    const addresses = [];
    const ttls = [];

    for (const res of results) {
      for (const ans of res.answers) {
        if (types.indexOf(ans.type) !== -1 && ans.address) {
          addresses.push(ans.address);
          if (ans.ttl > 0) ttls.push(ans.ttl);
        }
      }
    }

    if (addresses.length === 0) throw new Error(`[${url}] empty answer`);

    const rtt = Date.now() - started;
    markDohSuccess(url, rtt);

    return {
      url,
      rtt,
      addresses,
      ttl: normalizeTTL(ttls.length ? Math.min.apply(null, ttls) : DEFAULT_TTL),
    };
  } catch (e) {
    markDohFailure(url, messageOf(e));
    throw e;
  }
}

async function query(url, domain, type, edns) {
  const queryBytes = encodeDNSQuery(domain, type, edns);
  const body = await dohGet(url, queryBytes);
  return decodeDNSResponse(body);
}

function dohGet(url, queryBytes) {
  const fullURL = url + (url.indexOf("?") === -1 ? "?" : "&") + "dns=" + base64url(queryBytes);

  const opt = {
    url: fullURL,
    headers: {
      Accept: "application/dns-message",
    },
    "binary-mode": true,
    encoding: null,
    timeout: TIMEOUT,
  };

  if ($.arg.policy && String($.arg.policy) !== "0") {
    opt.policy = $.arg.policy;
  }

  return new Promise((resolve, reject) => {
    $httpClient.get(opt, (error, response, data) => {
      if (error) return reject(error);
      if (!response) return reject(new Error("No HTTP response"));

      const status = response.status || response.statusCode || 200;
      if (status < 200 || status >= 300) {
        return reject(new Error(`HTTP ${status}`));
      }

      const bytes = toBytes(data);
      if (!bytes || bytes.length < 12) {
        return reject(new Error("Invalid DNS response body"));
      }

      resolve(bytes);
    });
  });
}

function pickDohs(dohList) {
  const limit = MAX_DOH > 0
    ? Math.min(MAX_DOH, HARD_CAP, dohList.length)
    : Math.min(HARD_CAP, dohList.length);

  const items = dohList.map((url, index) => {
    const info = (state.doh && state.doh[url]) || {};
    return {
      url,
      index,
      info,
      down: (info.downUntil || 0) > now,
    };
  });

  const available = items.filter((item) => !item.down);
  const pool = available.length > 0 ? available : items;

  pool.sort((a, b) => {
    const aLastOk = a.info.lastOk || 0;
    const bLastOk = b.info.lastOk || 0;
    const aDown = a.down ? 1 : 0;
    const bDown = b.down ? 1 : 0;

    if (aDown !== bDown) return aDown - bDown;
    if (aLastOk !== bLastOk) return bLastOk - aLastOk;

    const aRtt = a.info.rtt || 999999;
    const bRtt = b.info.rtt || 999999;
    if (aRtt !== bRtt) return aRtt - bRtt;

    const aFail = a.info.fail || 0;
    const bFail = b.info.fail || 0;
    if (aFail !== bFail) return aFail - bFail;

    return a.index - b.index;
  });

  return pool.slice(0, limit).map((item) => item.url);
}

function markDohSuccess(url, rtt) {
  const info = ensureDohInfo(url);

  info.ok = (info.ok || 0) + 1;
  info.fail = 0;
  info.rtt = rtt;
  info.lastOk = Date.now();
  info.lastError = "";
  info.downUntil = 0;

  saveState();
}

function markDohFailure(url, error) {
  const info = ensureDohInfo(url);

  info.fail = (info.fail || 0) + 1;
  info.lastFail = Date.now();
  info.lastError = String(error || "").slice(0, 120);

  if (info.fail >= FAIL_LIMIT) {
    info.downUntil = Date.now() + COOLDOWN;
    log(`[${$.domain}] cooldown ${url} for ${COOLDOWN / 1000}s: ${info.lastError}`);
  }

  saveState();
}

function ensureDohInfo(url) {
  if (!state.doh) state.doh = {};
  if (!state.doh[url]) state.doh[url] = {};
  return state.doh[url];
}

function loadState() {
  try {
    const raw = $persistentStore.read(STORE_KEY);
    const obj = raw ? JSON.parse(raw) : {};

    if (!obj || typeof obj !== "object") return { v: 3, doh: {} };
    if (!obj.doh || typeof obj.doh !== "object") obj.doh = {};

    return obj;
  } catch (e) {
    return { v: 3, doh: {} };
  }
}

function saveState() {
  try {
    state.v = 3;
    state.updated = Date.now();
    pruneState();
    $persistentStore.write(JSON.stringify(state), STORE_KEY);
  } catch (e) {
    log(`save state failed: ${messageOf(e)}`);
  }
}

function pruneState() {
  if (!state.doh) return;

  const entries = [];
  const cutoff = Date.now() - STATE_TTL;

  for (const url in state.doh) {
    if (!Object.prototype.hasOwnProperty.call(state.doh, url)) continue;

    const info = state.doh[url] || {};
    const ts = Math.max(info.lastOk || 0, info.lastFail || 0, info.downUntil || 0);

    if (ts && ts < cutoff) {
      delete state.doh[url];
      continue;
    }

    entries.push({ url, ts });
  }

  entries.sort((a, b) => b.ts - a.ts);

  for (let i = 20; i < entries.length; i++) {
    delete state.doh[entries[i].url];
  }
}

function encodeDNSQuery(domain, type, edns) {
  const bytes = [];
  const qtype = rrType(type);
  const ecs = edns ? buildECS(edns) : null;

  writeU16(bytes, Math.floor(Math.random() * 65536));
  writeU16(bytes, 0x0100);
  writeU16(bytes, 1);
  writeU16(bytes, 0);
  writeU16(bytes, 0);
  writeU16(bytes, ecs ? 1 : 0);

  writeName(bytes, domain);
  writeU16(bytes, qtype);
  writeU16(bytes, 1);

  if (ecs) {
    writeU8(bytes, 0);
    writeU16(bytes, 41);
    writeU16(bytes, 4096);
    writeU32(bytes, 0);

    const rdata = [];
    writeU16(rdata, 8);
    writeU16(rdata, 4 + ecs.address.length);
    writeU16(rdata, ecs.family);
    writeU8(rdata, ecs.prefix);
    writeU8(rdata, 0);

    for (const b of ecs.address) writeU8(rdata, b);

    writeU16(bytes, rdata.length);

    for (const b of rdata) writeU8(bytes, b);
  }

  return new Uint8Array(bytes);
}

function decodeDNSResponse(bytes) {
  let offset = 0;

  if (bytes.length < 12) throw new Error("DNS response too short");

  const id = readU16(bytes, offset);
  offset += 2;

  const flags = readU16(bytes, offset);
  offset += 2;

  const qd = readU16(bytes, offset);
  offset += 2;

  const an = readU16(bytes, offset);
  offset += 2;

  const ns = readU16(bytes, offset);
  offset += 2;

  const ar = readU16(bytes, offset);
  offset += 2;

  const rcode = flags & 0x000f;

  if (rcode !== 0) throw new Error(`DNS RCODE ${rcode}`);

  for (let i = 0; i < qd; i++) {
    const qn = readName(bytes, offset);
    offset = qn.offset + 4;
  }

  const answers = [];

  for (let i = 0; i < an; i++) {
    const rr = readRecord(bytes, offset);
    offset = rr.offset;

    if (rr.answer) answers.push(rr.answer);
  }

  return { id, answers, ns, ar };
}

function readRecord(bytes, offset) {
  const nameInfo = readName(bytes, offset);
  offset = nameInfo.offset;

  const typeCode = readU16(bytes, offset);
  offset += 2;

  const klass = readU16(bytes, offset);
  offset += 2;

  const ttl = readU32(bytes, offset);
  offset += 4;

  const rdlen = readU16(bytes, offset);
  offset += 2;

  const rdataOffset = offset;
  const nextOffset = offset + rdlen;

  let answer = null;

  if (typeCode === 1 && rdlen === 4) {
    answer = {
      name: nameInfo.name,
      type: "A",
      ttl,
      address: `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`,
    };
  } else if (typeCode === 28 && rdlen === 16) {
    answer = {
      name: nameInfo.name,
      type: "AAAA",
      ttl,
      address: ipv6BytesToString(bytes.slice(offset, offset + 16)),
    };
  }

  return { answer, offset: nextOffset, klass, rdataOffset };
}

function readName(bytes, offset) {
  const labels = [];
  let pos = offset;
  let jumped = false;
  let nextOffset = offset;
  let jumps = 0;

  while (true) {
    if (pos >= bytes.length) throw new Error("Invalid DNS name");

    const len = bytes[pos];

    if (len === 0) {
      pos += 1;
      if (!jumped) nextOffset = pos;
      break;
    }

    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= bytes.length) throw new Error("Invalid DNS pointer");

      const ptr = ((len & 0x3f) << 8) | bytes[pos + 1];

      if (!jumped) nextOffset = pos + 2;

      pos = ptr;
      jumped = true;
      jumps += 1;

      if (jumps > 32) throw new Error("DNS pointer loop");

      continue;
    }

    if ((len & 0xc0) !== 0) throw new Error("Unsupported DNS label");

    pos += 1;

    if (pos + len > bytes.length) throw new Error("Invalid DNS label length");

    let label = "";

    for (let i = 0; i < len; i++) {
      label += String.fromCharCode(bytes[pos + i]);
    }

    labels.push(label);
    pos += len;

    if (!jumped) nextOffset = pos;
  }

  return {
    name: labels.join("."),
    offset: nextOffset,
  };
}

function buildECS(ip) {
  if (isIPv4(ip)) {
    const raw = ip.split(".").map((n) => parseInt(n, 10));
    return {
      family: 1,
      prefix: 24,
      address: raw.slice(0, 3),
    };
  }

  const v6 = ipv6ToBytes(ip);

  if (v6) {
    return {
      family: 2,
      prefix: 56,
      address: Array.from(v6.slice(0, 7)),
    };
  }

  return null;
}

function getEDNS() {
  let edns = $.arg.edns;

  if (edns === "auto") {
    try {
      const raw = $persistentStore.read("lastNetworkInfoEvent");
      edns = raw ? JSON.parse(raw).CN_IP : "";
    } catch (e) {
      log(`read auto edns failed: ${messageOf(e)}`);
      edns = "";
    }
  }

  if (edns === undefined || edns === null || edns === "") {
    edns = "0";
  }

  edns = String(edns).trim();

  if (/^(0|false|off|none|no)$/i.test(edns)) return null;

  if (!isIPv4(edns) && !ipv6ToBytes(edns)) {
    log(`invalid edns ignored: ${edns}`);
    return null;
  }

  return edns;
}

function getDohList(input) {
  const seen = {};
  const out = [];

  String(input)
    .split(/\s*,\s*/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s))
    .forEach((url) => {
      const normalized = url.replace(/\s+/g, "");

      if (!normalized || seen[normalized]) return;

      seen[normalized] = true;
      out.push(normalized);
    });

  return out;
}

function rrType(type) {
  type = String(type).toUpperCase();

  if (type === "A") return 1;
  if (type === "AAAA") return 28;

  throw new Error(`Unsupported query type: ${type}`);
}

function normalizeTTL(ttl) {
  let t = toInt(ttl, DEFAULT_TTL);

  if (t < MIN_TTL) t = MIN_TTL;
  if (t > MAX_TTL) t = MAX_TTL;

  return t;
}

function firstFulfilledStaggered(tasks, delay) {
  return new Promise((resolve, reject) => {
    if (!tasks.length) return reject(new Error("No task"));

    let pending = tasks.length;
    let lastError = null;
    let settled = false;

    function start(index) {
      if (settled) return;

      Promise.resolve()
        .then(tasks[index])
        .then((value) => {
          if (settled) return;

          settled = true;
          resolve(value);
        })
        .catch((e) => {
          lastError = e;
          pending -= 1;

          if (!settled && pending === 0) {
            reject(lastError || new Error("All DoH queries failed"));
          }
        });
    }

    for (let i = 0; i < tasks.length; i++) {
      if (i === 0 || delay <= 0) {
        start(i);
      } else {
        setTimeout(() => start(i), delay * i);
      }
    }
  });
}

function base64url(bytes) {
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;

  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];

    out += table[(n >> 18) & 63];
    out += table[(n >> 12) & 63];
    out += table[(n >> 6) & 63];
    out += table[n & 63];
  }

  const remain = bytes.length - i;

  if (remain === 1) {
    const n = bytes[i] << 16;

    out += table[(n >> 18) & 63];
    out += table[(n >> 12) & 63];
  } else if (remain === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);

    out += table[(n >> 18) & 63];
    out += table[(n >> 12) & 63];
    out += table[(n >> 6) & 63];
  }

  return out.replace(/\+/g, "-").replace(/\//g, "_");
}

function toBytes(data) {
  if (!data) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;

  if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  if (typeof data === "string") {
    const out = new Uint8Array(data.length);

    for (let i = 0; i < data.length; i++) {
      out[i] = data.charCodeAt(i) & 0xff;
    }

    return out;
  }

  if (typeof data.length === "number") {
    const out = new Uint8Array(data.length);

    for (let i = 0; i < data.length; i++) {
      out[i] = data[i] & 0xff;
    }

    return out;
  }

  return new Uint8Array(0);
}

function writeName(bytes, name) {
  const normalized = String(name || "").replace(/\.$/, "");
  const labels = normalized.split(".").filter(Boolean);

  for (const label of labels) {
    if (label.length > 63) throw new Error("DNS label too long");

    writeU8(bytes, label.length);

    for (let i = 0; i < label.length; i++) {
      writeU8(bytes, label.charCodeAt(i) & 0xff);
    }
  }

  writeU8(bytes, 0);
}

function writeU8(bytes, n) {
  bytes.push(n & 0xff);
}

function writeU16(bytes, n) {
  bytes.push((n >> 8) & 0xff, n & 0xff);
}

function writeU32(bytes, n) {
  bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function readU16(bytes, offset) {
  return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
}

function readU32(bytes, offset) {
  return (
    ((bytes[offset] << 24) >>> 0) +
    ((bytes[offset + 1] << 16) >>> 0) +
    ((bytes[offset + 2] << 8) >>> 0) +
    bytes[offset + 3]
  ) >>> 0;
}

function ipv6BytesToString(bytes) {
  const groups = [];

  for (let i = 0; i < 16; i += 2) {
    groups.push(((bytes[i] << 8) | bytes[i + 1]) >>> 0);
  }

  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;

  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen += 1;
    } else {
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }

      curStart = -1;
      curLen = 0;
    }
  }

  if (bestLen < 2) bestStart = -1;

  if (bestStart !== -1) {
    const left = groups.slice(0, bestStart).map((g) => g.toString(16)).join(":");
    const right = groups.slice(bestStart + bestLen).map((g) => g.toString(16)).join(":");

    if (left && right) return `${left}::${right}`;
    if (left) return `${left}::`;
    if (right) return `::${right}`;

    return "::";
  }

  return groups.map((g) => g.toString(16)).join(":");
}

function ipv6ToBytes(ip) {
  ip = String(ip || "").split("%")[0].trim();

  if (!ip || ip.indexOf(":") === -1) return null;

  if (ip.indexOf(".") !== -1) {
    const lastColon = ip.lastIndexOf(":");
    const v4 = ip.slice(lastColon + 1);

    if (!isIPv4(v4)) return null;

    const nums = v4.split(".").map((n) => parseInt(n, 10));
    const h1 = ((nums[0] << 8) | nums[1]).toString(16);
    const h2 = ((nums[2] << 8) | nums[3]).toString(16);

    ip = ip.slice(0, lastColon) + ":" + h1 + ":" + h2;
  }

  const halves = ip.split("::");

  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":").filter((x) => x.length) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":").filter((x) => x.length) : [];

  let groups;

  if (halves.length === 2) {
    const zeros = 8 - head.length - tail.length;

    if (zeros < 0) return null;

    groups = head.concat(new Array(zeros).fill("0"), tail);
  } else {
    groups = head;
  }

  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);

  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;

    const n = parseInt(groups[i], 16);

    bytes[i * 2] = (n >> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }

  return bytes;
}

function isIPv4(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip))) return false;

  return String(ip).split(".").every((n) => {
    const v = parseInt(n, 10);

    return String(v) === String(Number(n)) && v >= 0 && v <= 255;
  });
}

function parseArgument(argument) {
  const result = {};

  if (!argument) return result;

  for (const part of String(argument).split("&")) {
    if (!part) continue;

    const index = part.indexOf("=");

    if (index === -1) {
      result[decode(part)] = "";
    } else {
      result[decode(part.slice(0, index))] = decode(part.slice(index + 1));
    }
  }

  return result;
}

function decode(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, "%20"));
  } catch (e) {
    return String(value);
  }
}

function unique(arr) {
  const seen = {};
  const out = [];

  for (const item of arr) {
    if (!item || seen[item]) continue;

    seen[item] = true;
    out.push(item);
  }

  return out;
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function messageOf(e) {
  return e && e.message ? e.message : String(e);
}

function log(...args) {
  if (LOG) console.log(...args);
}

function done(value) {
  $done(value || {});
}