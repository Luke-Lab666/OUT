/*
 * WeatherKit27.response.js
 * Surge iOS 27 WeatherKit adapter.
 * v1.1: provider parallel fetch + safer cache merge.
 *
 * Stable core:
 * - Preserves iOS27 WK2.Weather 16-field root. No full FlatBuffer rebuild.
 * - AQI: verified in-place scalar patch for WK2.AirQuality value/category.
 *
 * Experimental precipitation:
 * - iOS27 Weather.app no longer relies on old forecastNextHour field4 for the visible precipitation panel.
 * - This script patches existing forecastHourly precipitation scalar fields only when they already exist.
 * - It does not add missing FlatBuffer fields, so no root/table rebuild risk.
 */
(() => {
  const NAME = 'WeatherKit27.response';
  const LEVEL = { OFF:0, ERROR:1, WARN:2, INFO:3, DEBUG:4, ALL:5 };
  const DEFAULT = {
    'AirQuality.Provider': 'WAQI',
    'AirQuality.Calculate.Algorithm': 'WAQI_InstantCast_CN',
    'Precipitation.Provider': 'QWeather',
    'API.ColorfulClouds.Token': '',
    'API.QWeather.Host': 'devapi.qweather.com',
    'API.QWeather.Token': '',
    'API.WAQI.Token': '',
    'Provider.CacheTTL': '1800',
    'Provider.LiveFetch': '1',
    'Provider.LiveTimeout': '1800',
    'Provider.PatchMode': 'InjectAll',
    'Precipitation.Hours': '12',
    'Precipitation.PatchExistingOnly': '1',
    'LogLevel': 'INFO',
    'DebugNotify': '0'
  };

  function parseArgs(s) {
    const o = Object.assign({}, DEFAULT);
    String(s || '').split('&').forEach(p => {
      const i = p.indexOf('=');
      if (i > 0) o[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1)).replace(/^"|"$/g, '');
    });
    return o;
  }
  const ARG = parseArgs(typeof $argument === 'string' ? $argument : '');
  const LOG = LEVEL[String(ARG.LogLevel || 'INFO').toUpperCase()] ?? 3;
  function log(l, m) { if (LOG >= LEVEL[l]) console.log(`[${NAME}] ${m}`); }
  function notify(t, s, b) { if (ARG.DebugNotify === '1' && typeof $notification !== 'undefined') $notification.post(t, s, b); }

  function hget(headers, key) {
    const low = key.toLowerCase();
    for (const k in (headers || {})) if (String(k).toLowerCase() === low) return String(headers[k] || '');
    return '';
  }
  function asU8(body) {
    if (!body) return new Uint8Array(0);
    if (body instanceof Uint8Array) return body;
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView && ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (typeof body === 'string') { const a = new Uint8Array(body.length); for (let i = 0; i < body.length; i++) a[i] = body.charCodeAt(i) & 255; return a; }
    return new Uint8Array(0);
  }

  function u16(b, o) { return (b[o] | (b[o + 1] << 8)) >>> 0; }
  function setU16(b, o, v) { v = Math.max(0, Math.min(65535, Math.round(Number(v) || 0))); b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function i32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) | 0; }
  function f32(b, o) {
    const dv = new DataView(b.buffer, b.byteOffset + o, 4);
    return dv.getFloat32(0, true);
  }
  function setF32(b, o, v) {
    const dv = new DataView(b.buffer, b.byteOffset + o, 4);
    dv.setFloat32(0, Number(v) || 0, true);
  }
  function validPos(b, p, n = 1) { return p >= 0 && p + n <= b.length; }
  function inspectTable(b, tablePos) {
    if (!validPos(b, tablePos, 4)) return { ok:false, reason:'bad table pos' };
    const vt = tablePos - i32(b, tablePos);
    if (!validPos(b, vt, 4)) return { ok:false, reason:`bad vtable ${vt}` };
    const vtLen = u16(b, vt), objSize = u16(b, vt + 2);
    if (vtLen < 4 || vtLen > 512 || !validPos(b, vt, vtLen)) return { ok:false, reason:`bad vtLen ${vtLen}` };
    const fieldCount = (vtLen - 4) >> 1;
    const present = [];
    for (let i = 0; i < fieldCount; i++) if (u16(b, vt + 4 + i * 2)) present.push(i);
    return { ok:true, tablePos, vt, vtLen, objSize, fieldCount, present };
  }
  function inspectRoot(b) {
    if (!b || b.length < 12) return { ok:false, reason:'too small' };
    const root = u32(b, 0);
    if (!validPos(b, root, 4)) return { ok:false, reason:`bad root ${root}` };
    const r = inspectTable(b, root); r.root = root; return r;
  }
  function fieldOffset(b, tablePos, fieldIndex) {
    const ti = inspectTable(b, tablePos); if (!ti.ok) return 0;
    const idx = 4 + fieldIndex * 2;
    if (idx + 2 > ti.vtLen) return 0;
    return u16(b, ti.vt + idx);
  }
  function tableFieldTarget(b, tablePos, fieldIndex) {
    const off = fieldOffset(b, tablePos, fieldIndex); if (!off) return 0;
    const loc = tablePos + off; if (!validPos(b, loc, 4)) return 0;
    const t = loc + u32(b, loc);
    return validPos(b, t, 4) ? t : 0;
  }
  function vectorTableEntries(b, vecPos, limit) {
    if (!validPos(b, vecPos, 4)) return [];
    const n = u32(b, vecPos); if (n <= 0 || n > 2048) return [];
    const out = [];
    const m = Math.min(n, limit || n);
    for (let i = 0; i < m; i++) {
      const loc = vecPos + 4 + i * 4;
      if (!validPos(b, loc, 4)) break;
      const t = loc + u32(b, loc);
      if (validPos(b, t, 4)) out.push({ index:i, pos:t });
    }
    return out;
  }

  function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
  function clamp(x, a, b) { x = Number(x) || 0; return Math.max(a, Math.min(b, x)); }
  function categoryCN(aqi) { aqi = num(aqi); if (aqi == null) return ''; if (aqi <= 50) return '优'; if (aqi <= 100) return '良'; if (aqi <= 150) return '轻度污染'; if (aqi <= 200) return '中度污染'; if (aqi <= 300) return '重度污染'; return '严重污染'; }
  function aqiCategoryIndex(aqi) { aqi = Number(aqi); if (!Number.isFinite(aqi)) return 0; if (aqi <= 50) return 1; if (aqi <= 100) return 2; if (aqi <= 150) return 3; if (aqi <= 200) return 4; if (aqi <= 300) return 5; return 6; }
  function cleanPollutants(p) {
    const out = {};
    [['pm25',['pm25','pm2p5','pm2_5']],['pm10',['pm10']],['o3',['o3']],['no2',['no2']],['so2',['so2']],['co',['co']]].forEach(([std, keys]) => {
      for (const k of keys) if (p && p[k] != null) { const v = (typeof p[k] === 'object' && p[k].v != null) ? p[k].v : p[k]; const n = num(v); if (n != null) { out[std] = n; break; } }
    });
    return out;
  }
  function euaqiFromPollutants(p) {
    const bands = { pm25:[10,20,25,50,75], pm10:[20,40,50,100,150], no2:[40,90,120,230,340], o3:[50,100,130,240,380], so2:[100,200,350,500,750] };
    let max = 0, primary = '', detail = [];
    for (const k of Object.keys(bands)) {
      const v = num(p && p[k]); if (v == null) continue;
      let lvl = 6; for (let i = 0; i < bands[k].length; i++) if (v <= bands[k][i]) { lvl = i + 1; break; }
      detail.push(`${k}=${v}->${lvl}`); if (lvl > max) { max = lvl; primary = k; }
    }
    return max ? { aqi:max, categoryIndex:max, primary, detail:detail.join(',') } : null;
  }
  function resolveAQI(aq) {
    if (!aq || num(aq.aqi) == null) return null;
    const algo = String(ARG['AirQuality.Calculate.Algorithm'] || 'WAQI_InstantCast_CN');
    if (/^EU_EAQI$/i.test(algo) && aq.provider !== 'WAQI') {
      const eu = euaqiFromPollutants(aq.pollutants || {});
      if (eu) return { aqi:eu.aqi, categoryIndex:eu.categoryIndex, provider:aq.provider, algorithm:'EU_EAQI', note:eu.detail };
    }
    const aqi = num(aq.aqi);
    return { aqi, categoryIndex:aqiCategoryIndex(aqi), provider:aq.provider, algorithm:algo, category:aq.category || categoryCN(aqi), note:'raw' };
  }

  function locFromUrl(url) {
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/v2\/weather\/[^/]+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    if (!m) throw new Error('no lat/lon');
    return { lat:Number(m[1]), lon:Number(m[2]), country:u.searchParams.get('country') || '', timezone:u.searchParams.get('timezone') || '' };
  }
  function keyOf(loc) { return `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`; }
  function cacheKey(loc) { return `WeatherKit27.cache.${keyOf(loc)}`; }
  function storeSet(k, v) { try { if (typeof $persistentStore !== 'undefined') $persistentStore.write(JSON.stringify(v), k); } catch (e) { log('WARN', `cache write fail ${e}`); } }
  function storeGet(k) { try { if (typeof $persistentStore === 'undefined') return null; const s = $persistentStore.read(k); return s ? JSON.parse(s) : null; } catch (_) { return null; } }
  function fresh(c, ttl, type) { return c && c.savedAt && (Date.now() - c.savedAt) < ttl * 1000 && c[type]; }

  function getJSON(url, headers, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), timeout || 1800);
      $httpClient.get({ url, headers:headers || {} }, (err, resp, data) => {
        clearTimeout(timer);
        if (err) return reject(err);
        const st = resp && resp.status;
        if (st && (st < 200 || st >= 300)) return reject(new Error(`HTTP ${st}`));
        try { resolve(typeof data === 'string' ? JSON.parse(data) : data); } catch (e) { reject(new Error(`JSON parse ${e.message}`)); }
      });
    });
  }

  function providerWanted(kind) {
    const p = String(ARG[kind === 'aqi' ? 'AirQuality.Provider' : 'Precipitation.Provider'] || 'Auto');
    if (p !== 'Auto') return p;
    if (kind === 'aqi') {
      if (ARG['API.WAQI.Token']) return 'WAQI';
      if (ARG['API.QWeather.Token']) return 'QWeather';
      if (ARG['API.ColorfulClouds.Token']) return 'ColorfulClouds';
      return 'WeatherKit';
    }
    if (ARG['API.QWeather.Token']) return 'QWeather';
    if (ARG['API.ColorfulClouds.Token']) return 'ColorfulClouds';
    return 'WeatherKit';
  }

  async function fetchWAQI(loc, timeout) {
    const token = ARG['API.WAQI.Token']; if (!token) throw new Error('missing WAQI token');
    const j = await getJSON(`https://api.waqi.info/feed/geo:${loc.lat};${loc.lon}/?token=${encodeURIComponent(token)}`, { Accept:'application/json' }, timeout);
    if (j.status !== 'ok') throw new Error(`WAQI status=${j.status || 'unknown'}`);
    const d = j.data || {}; const aqi = num(d.aqi);
    return { provider:'WAQI', aqi, scale:'WAQI', category:categoryCN(aqi), primary:d.dominentpol || '', pollutants:cleanPollutants(d.iaqi || {}), updatedAt:d.time && (d.time.iso || d.time.s) || new Date().toISOString() };
  }
  async function fetchQWeatherAQI(loc, timeout) {
    const token = ARG['API.QWeather.Token']; if (!token) throw new Error('missing QWeather token');
    const host = (ARG['API.QWeather.Host'] || 'devapi.qweather.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const j = await getJSON(`https://${host}/v7/air/now?location=${loc.lon},${loc.lat}&key=${encodeURIComponent(token)}`, { Accept:'application/json' }, timeout);
    if (j.code && !/^2/.test(String(j.code))) throw new Error(`QWeather air code=${j.code}`);
    const n = j.now || {}; const aqi = num(n.aqi);
    return { provider:'QWeather', aqi, scale:'CN', category:n.category || categoryCN(aqi), primary:n.primary || '', pollutants:cleanPollutants(n), updatedAt:n.pubTime || j.updateTime || new Date().toISOString() };
  }
  async function fetchCaiyunAQI(loc, timeout) {
    const token = ARG['API.ColorfulClouds.Token']; if (!token) throw new Error('missing ColorfulClouds token');
    const j = await getJSON(`https://api.caiyunapp.com/v2.6/${encodeURIComponent(token)}/${loc.lon},${loc.lat}/weather?lang=zh_CN&unit=metric:v2&alert=false&dailysteps=1&hourlysteps=1`, { Accept:'application/json' }, timeout);
    const aq = (((j.result || {}).realtime || {}).air_quality || {});
    const aqiObj = aq.aqi || {}; const aqi = num(aqiObj.chn ?? aqiObj.usa ?? aqiObj.value ?? aq.aqi);
    return { provider:'ColorfulClouds', aqi, scale:aqiObj.chn != null ? 'CN' : (aqiObj.usa != null ? 'US' : ''), category:categoryCN(aqi), primary:'', pollutants:cleanPollutants(aq), updatedAt:new Date().toISOString() };
  }
  async function getAQI(loc) {
    const ttl = Math.max(30, Number(ARG['Provider.CacheTTL'] || 1800));
    const k = cacheKey(loc); const c = storeGet(k);
    if (fresh(c, ttl, 'airQuality') && num(c.airQuality.aqi) != null) { log('INFO', `AQI cache hit ${keyOf(loc)} ${c.airQuality.provider}=${c.airQuality.aqi}`); return c.airQuality; }
    if (ARG['Provider.LiveFetch'] === '0') return null;
    const provider = providerWanted('aqi'); if (provider === 'WeatherKit') return null;
    const timeout = Math.max(700, Number(ARG['Provider.LiveTimeout'] || 1800));
    let aq = null;
    if (provider === 'WAQI') aq = await fetchWAQI(loc, timeout);
    else if (provider === 'QWeather') aq = await fetchQWeatherAQI(loc, timeout);
    else if (provider === 'ColorfulClouds') aq = await fetchCaiyunAQI(loc, timeout);
    if (aq && num(aq.aqi) != null) {
      const latest = storeGet(k) || c || {};
      storeSet(k, Object.assign({}, latest, { savedAt:Date.now(), location:loc, airQuality:aq }));
    }
    return aq;
  }

  function parseTimeMs(s) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
  async function fetchQWeatherMinutely(loc, timeout) {
    const token = ARG['API.QWeather.Token']; if (!token) throw new Error('missing QWeather token');
    const host = (ARG['API.QWeather.Host'] || 'devapi.qweather.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const j = await getJSON(`https://${host}/v7/minutely/5m?location=${loc.lon},${loc.lat}&key=${encodeURIComponent(token)}`, { Accept:'application/json' }, timeout);
    if (j.code && !/^2/.test(String(j.code))) throw new Error(`QWeather minutely code=${j.code}`);
    const rows = (j.minutely || []).map((x, i) => ({
      t: parseTimeMs(x.fxTime) || (Date.now() + i * 5 * 60000),
      precip: Math.max(0, Number(x.precip || 0)),
      type: x.type || '',
      probability: x.prob != null ? clamp(Number(x.prob) / 100, 0, 1) : null
    }));
    return { provider:'QWeather', summary:j.summary || '', rows, updatedAt:j.updateTime || new Date().toISOString() };
  }
  async function fetchCaiyunMinutely(loc, timeout) {
    const token = ARG['API.ColorfulClouds.Token']; if (!token) throw new Error('missing ColorfulClouds token');
    const j = await getJSON(`https://api.caiyunapp.com/v2.6/${encodeURIComponent(token)}/${loc.lon},${loc.lat}/weather?lang=zh_CN&unit=metric:v2&alert=false&dailysteps=1&hourlysteps=12`, { Accept:'application/json' }, timeout);
    const result = j.result || {}; const min = result.minutely || {}; const rows = [];
    const p2h = min.precipitation_2h || min.precipitation || [];
    for (let i = 0; i < p2h.length; i++) rows.push({ t:Date.now() + i * 60000, precip:Math.max(0, Number(p2h[i] || 0)), type:'rain', probability:null });
    const hourly = (result.hourly && result.hourly.precipitation) || [];
    if (!rows.length && Array.isArray(hourly)) {
      hourly.forEach((x, i) => rows.push({ t:parseTimeMs(x.datetime) || (Date.now() + i * 3600000), precip:Math.max(0, Number(x.value || 0)), type:'rain', probability:null }));
    }
    return { provider:'ColorfulClouds', summary:min.description || '', rows, updatedAt:new Date().toISOString() };
  }
  function aggregateHourly(precip) {
    const hours = Math.max(1, Math.min(24, Number(ARG['Precipitation.Hours'] || 12)));
    const now = Date.now(); const buckets = [];
    for (let h = 0; h < hours; h++) buckets.push({ hour:h, amount:0, max:0, points:0, probability:0, type:'' });
    for (const r of ((precip && precip.rows) || [])) {
      const diff = r.t - now; const h = Math.floor(diff / 3600000);
      if (h < 0 || h >= hours) continue;
      const mm = Math.max(0, Number(r.precip || 0));
      buckets[h].amount += mm;
      buckets[h].max = Math.max(buckets[h].max, mm);
      buckets[h].points++;
      if (r.type) buckets[h].type = r.type;
      if (r.probability != null) buckets[h].probability = Math.max(buckets[h].probability, clamp(r.probability, 0, 1));
    }
    for (const b of buckets) {
      if (!b.probability) {
        if (b.amount <= 0) b.probability = 0;
        else b.probability = clamp(0.55 + Math.min(0.4, b.amount * 0.12), 0.55, 1);
      }
      b.intensity = b.points ? b.amount / Math.max(1, b.points) : 0;
    }
    return buckets;
  }
  async function getPrecip(loc) {
    const ttl = Math.max(30, Number(ARG['Provider.CacheTTL'] || 1800));
    const k = cacheKey(loc); const c = storeGet(k);
    if (fresh(c, ttl, 'precipitation')) { log('INFO', `Precip cache hit ${keyOf(loc)} ${c.precipitation.provider} rows=${(c.precipitation.rows || []).length}`); return c.precipitation; }
    if (ARG['Provider.LiveFetch'] === '0') return null;
    const provider = providerWanted('precip'); if (provider === 'WeatherKit') return null;
    const timeout = Math.max(700, Number(ARG['Provider.LiveTimeout'] || 1800));
    let pr = null;
    if (provider === 'QWeather') pr = await fetchQWeatherMinutely(loc, timeout);
    else if (provider === 'ColorfulClouds') pr = await fetchCaiyunMinutely(loc, timeout);
    if (pr && Array.isArray(pr.rows)) {
      const latest = storeGet(k) || c || {};
      storeSet(k, Object.assign({}, latest, { savedAt:Date.now(), location:loc, precipitation:pr }));
    }
    return pr;
  }

  function patchAirQualityInPlace(body, resolved) {
    const mode = String(ARG['Provider.PatchMode'] || 'InjectAll').toLowerCase();
    if (!/(inject|aqi|all)/.test(mode)) return { patched:false, reason:`PatchMode=${ARG['Provider.PatchMode']}` };
    if (!resolved || num(resolved.aqi) == null) return { patched:false, reason:'no provider AQI' };
    const info = inspectRoot(body); if (!info.ok) return { patched:false, reason:`root ${info.reason}` };
    const airQ = tableFieldTarget(body, info.root, 0); if (!airQ) return { patched:false, reason:'WK2 field0 airQuality missing' };
    const aqiOff = fieldOffset(body, airQ, 2); const catOff = fieldOffset(body, airQ, 1);
    if (!aqiOff) return { patched:false, reason:'AQI scalar field missing' };
    const oldAqi = u16(body, airQ + aqiOff), oldCat = catOff ? body[airQ + catOff] : 0;
    setU16(body, airQ + aqiOff, resolved.aqi);
    if (catOff) body[airQ + catOff] = (resolved.categoryIndex || aqiCategoryIndex(resolved.aqi)) & 255;
    return { patched:true, oldAqi, newAqi:Math.round(resolved.aqi), oldCat, newCat:resolved.categoryIndex || aqiCategoryIndex(resolved.aqi), provider:resolved.provider || '', algorithm:resolved.algorithm || '' };
  }

  function entryUnix(body, pos) {
    const off = fieldOffset(body, pos, 0); if (!off) return 0;
    const loc = pos + off; if (!validPos(body, loc, 4)) return 0;
    const t = u32(body, loc);
    return (t > 1500000000 && t < 2200000000) ? t : 0;
  }
  function findCurrentEntry(entries) {
    const now = Math.floor(Date.now() / 1000);
    let idx = 0;
    for (let i = 0; i < entries.length; i++) {
      const t = entryUnix(entries[i].body, entries[i].pos);
      if (t && t <= now + 1800) idx = i;
      if (t && t > now + 1800) break;
    }
    return idx;
  }
  function patchHourlyPrecip(body, precip) {
    const mode = String(ARG['Provider.PatchMode'] || 'InjectAll').toLowerCase();
    if (!/(injectall|precip|hourly|all)/.test(mode)) return { patched:0, reason:`PatchMode=${ARG['Provider.PatchMode']}` };
    if (!precip || !Array.isArray(precip.rows) || !precip.rows.length) return { patched:0, reason:'no provider precipitation' };
    const rootInfo = inspectRoot(body); if (!rootInfo.ok) return { patched:0, reason:`root ${rootInfo.reason}` };
    const hourlyWrapper = tableFieldTarget(body, rootInfo.root, 3);
    if (!hourlyWrapper) return { patched:0, reason:'WK2 field3 forecastHourly missing' };
    const vec = tableFieldTarget(body, hourlyWrapper, 1);
    if (!vec) return { patched:0, reason:'forecastHourly vector missing' };
    const entries = vectorTableEntries(body, vec, 400).map(e => Object.assign({ body }, e));
    if (!entries.length) return { patched:0, reason:'forecastHourly entries missing' };
    const buckets = aggregateHourly(precip);
    const start = findCurrentEntry(entries);
    const maxHours = Math.min(buckets.length, Math.max(1, Math.min(24, Number(ARG['Precipitation.Hours'] || 12))));
    let patched = 0, skipped = 0, sample = [];
    for (let h = 0; h < maxHours; h++) {
      const e = entries[start + h]; if (!e) break;
      const b = buckets[h];
      // Observed iOS27 rainy sample: forecastHourly entries have fields 8/9/10 as precipitation related floats.
      // Non-rain samples often lack these fields; we skip rather than rebuild/add fields.
      const off8 = fieldOffset(body, e.pos, 8);
      const off9 = fieldOffset(body, e.pos, 9);
      const off10 = fieldOffset(body, e.pos, 10);
      if (!off8 && !off9 && !off10) { skipped++; continue; }
      const chance = clamp(b.probability, 0, 1);
      const amount = Math.max(0, Number(b.amount || 0));
      const amountOrTiny = amount > 0 ? amount : 0;
      try {
        if (off8 && validPos(body, e.pos + off8, 4)) setF32(body, e.pos + off8, chance);
        if (off9 && validPos(body, e.pos + off9, 4)) setF32(body, e.pos + off9, amountOrTiny);
        if (off10 && validPos(body, e.pos + off10, 4)) setF32(body, e.pos + off10, amountOrTiny);
        patched++;
        if (sample.length < 4) sample.push(`h${h}:p=${chance.toFixed(2)},mm=${amount.toFixed(2)}`);
      } catch (err) {
        skipped++;
      }
    }
    return { patched, skipped, provider:precip.provider, summary:precip.summary || '', sample:sample.join('|') };
  }

  async function main() {
    const ct = hget($response.headers, 'Content-Type');
    if (!/application\/vnd\.apple\.flatbuffer/i.test(ct) || !/WK2\.Weather/i.test(ct)) { log('DEBUG', `skip content-type=${ct}`); return $done({}); }
    const loc = locFromUrl($request.url);
    const body = asU8($response.body);
    const info = inspectRoot(body);
    if (info.ok) log('INFO', `WK2.Weather ${keyOf(loc)} len=${body.length} fields=${info.fieldCount} present=[${info.present.join(',')}]`);
    else log('WARN', `WK2 inspect fail ${info.reason}`);

    let changed = false;

    const mode = String(ARG['Provider.PatchMode'] || 'InjectAll').toLowerCase();
    const needAQI = /(injectall|inject|aqi|all)/.test(mode);
    const needPrecip = /(injectall|precip|hourly|all)/.test(mode);

    // v1.1: AQI 和降水并行拉取，避免 WAQI 后再等 QWeather 导致 Weather.app CANCEL。
    const aqJob = needAQI ? getAQI(loc).then(v => ({ ok:true, value:v })).catch(e => ({ ok:false, error:e })) : Promise.resolve({ ok:true, value:null });
    const prJob = needPrecip ? getPrecip(loc).then(v => ({ ok:true, value:v })).catch(e => ({ ok:false, error:e })) : Promise.resolve({ ok:true, value:null });
    const [aqRes, prRes] = await Promise.all([aqJob, prJob]);

    let aq = null;
    if (aqRes.ok) aq = aqRes.value;
    else { log('WARN', `AQI provider failed: ${aqRes.error && aqRes.error.message || aqRes.error}`); notify('WeatherKit27', 'AQI provider failed', String(aqRes.error && aqRes.error.message || aqRes.error)); }

    const resolved = resolveAQI(aq);
    if (resolved) log('INFO', `AQI provider=${resolved.provider} raw=${aq.aqi} patch=${resolved.aqi}/${resolved.categoryIndex} algorithm=${resolved.algorithm} ${resolved.note || ''}`);
    const ap = patchAirQualityInPlace(body, resolved);
    if (ap.patched) { changed = true; log('WARN', `injectAQI: ${ap.oldAqi}/${ap.oldCat} -> ${ap.newAqi}/${ap.newCat} provider=${ap.provider} algorithm=${ap.algorithm}`); }
    else log('INFO', `injectAQI skipped: ${ap.reason}`);

    let pr = null;
    if (prRes.ok) pr = prRes.value;
    else { log('WARN', `Precip provider failed: ${prRes.error && prRes.error.message || prRes.error}`); notify('WeatherKit27', 'Precip provider failed', String(prRes.error && prRes.error.message || prRes.error)); }

    if (pr) log('INFO', `Precip provider=${pr.provider} rows=${(pr.rows || []).length} summary=${pr.summary || ''}`);
    const pp = patchHourlyPrecip(body, pr);
    if (pp.patched > 0) { changed = true; log('WARN', `injectPrecipHourly: patched=${pp.patched} skipped=${pp.skipped} provider=${pp.provider} ${pp.sample || ''}`); }
    else log('INFO', `injectPrecipHourly skipped: ${pp.reason}${pp.skipped ? ` skipped=${pp.skipped}` : ''}`);

    return changed ? $done({ body }) : $done({});
  }

  main().catch(e => { console.log(`[${NAME}] ERROR ${e && e.stack || e}`); $done({}); });
})();
