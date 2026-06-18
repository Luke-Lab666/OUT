/*
 * WeatherKit iOS27 Provider Adapter - response.js
 * 接入：ColorfulClouds / QWeather / WAQI
 * 当前策略：Provider 数据拉取 + 标准化 + PersistentStore 缓存；WK2.Weather 二进制默认原样放行。
 * 原因：iOS27 WK2.Weather 为 16-field FlatBuffer；在字段映射完全确认前强行重编码会导致 AQI/forecastNextHour/highlights/dataNotice 丢失。
 */
(() => {
  const NAME = 'WK27.Provider.response';
  const LEVEL = { OFF:0, ERROR:1, WARN:2, INFO:3, DEBUG:4, ALL:5 };
  const DEFAULT = {
    'NextHour.Provider':'Auto',
    'AirQuality.Provider':'Auto',
    'AirQuality.Calculate.Algorithm':'WAQI_InstantCast_CN',
    'API.ColorfulClouds.Token':'',
    'API.QWeather.Host':'devapi.qweather.com',
    'API.QWeather.Token':'',
    'API.WAQI.Token':'',
    'Provider.CacheTTL':'300',
    'Provider.PatchMode':'InjectAQI',
    'LogLevel':'INFO',
    'DebugNotify':'0'
  };
  function args(s){const o=Object.assign({},DEFAULT);(s||'').split('&').forEach(p=>{const i=p.indexOf('=');if(i>0){const k=decodeURIComponent(p.slice(0,i));let v=decodeURIComponent(p.slice(i+1));v=String(v).replace(/^"|"$/g,'');o[k]=v;}});return o;}
  const ARG = args(typeof $argument === 'string' ? $argument : '');
  const LOG = LEVEL[String(ARG.LogLevel||'INFO').toUpperCase()] ?? 3;
  function log(l,m){ if(LOG >= LEVEL[l]) console.log(`[${NAME}] ${m}`); }
  function notify(title, sub, body){ if(ARG.DebugNotify==='1' && typeof $notification!=='undefined') $notification.post(title, sub, body); }
  function hget(headers, key){ const low=key.toLowerCase(); for(const k in (headers||{})){ if(String(k).toLowerCase()===low) return String(headers[k]||''); } return ''; }
  function asU8(body){ if(!body) return new Uint8Array(0); if(body instanceof Uint8Array) return body; if(typeof ArrayBuffer!=='undefined' && body instanceof ArrayBuffer) return new Uint8Array(body); if(ArrayBuffer.isView && ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength); if(typeof body==='string'){const a=new Uint8Array(body.length); for(let i=0;i<body.length;i++) a[i]=body.charCodeAt(i)&255; return a;} return new Uint8Array(0); }
  function u16(b,o){ return (b[o] | (b[o+1]<<8)) >>> 0; }
  function u32(b,o){ return (b[o] | (b[o+1]<<8) | (b[o+2]<<16) | (b[o+3]<<24)) >>> 0; }
  function i32(b,o){ return (b[o] | (b[o+1]<<8) | (b[o+2]<<16) | (b[o+3]<<24)) | 0; }
  function inspectRoot(b){
    if(!b || b.length<12) return {ok:false,reason:'too small'};
    const root=u32(b,0); if(root<4 || root+4>b.length) return {ok:false,reason:`bad root ${root}`};
    const vt=root-i32(b,root); if(vt<0 || vt+4>b.length) return {ok:false,reason:`bad vtable ${vt}`};
    const vtLen=u16(b,vt), objSize=u16(b,vt+2); if(vtLen<4 || vtLen>512 || vt+vtLen>b.length) return {ok:false,reason:`bad vtLen ${vtLen}`};
    const n=(vtLen-4)>>1, present=[]; for(let i=0;i<n;i++){ if(u16(b,vt+4+i*2)) present.push(i); }
    return {ok:true,root,vt,vtLen,objSize,fieldCount:n,present};
  }
  function setU16(b,o,v){ v=Math.max(0,Math.min(65535,Math.round(Number(v)||0))); b[o]=v&255; b[o+1]=(v>>>8)&255; }
  function getFieldOffset(b, tablePos, fieldIndex){
    if(!b || tablePos<4 || tablePos+4>b.length) return 0;
    const vt = tablePos - i32(b, tablePos);
    if(vt<0 || vt+4>b.length) return 0;
    const vtLen = u16(b, vt);
    const indexOffset = 4 + fieldIndex * 2;
    if(indexOffset + 2 > vtLen) return 0;
    return u16(b, vt + indexOffset);
  }
  function getTableFieldTarget(b, tablePos, fieldIndex){
    const off = getFieldOffset(b, tablePos, fieldIndex);
    if(!off) return 0;
    const loc = tablePos + off;
    if(loc < 0 || loc + 4 > b.length) return 0;
    const rel = u32(b, loc);
    const target = loc + rel;
    if(target < 4 || target >= b.length) return 0;
    return target;
  }
  function aqiCategoryIndex(aqi){
    aqi = Number(aqi);
    if(!Number.isFinite(aqi)) return 0;
    if(aqi <= 50) return 1;
    if(aqi <= 100) return 2;
    if(aqi <= 150) return 3;
    if(aqi <= 200) return 4;
    if(aqi <= 300) return 5;
    return 6;
  }
  function patchAirQualityInPlace(body, bundle){
    const mode = String(ARG['Provider.PatchMode'] || 'Preserve').toLowerCase();
    if(!/inject|aqi|all/.test(mode)) return {patched:false, reason:`PatchMode=${ARG['Provider.PatchMode']}`};
    const aq = bundle && bundle.airQuality;
    const aqi = aq && Number(aq.aqi);
    if(!Number.isFinite(aqi)) return {patched:false, reason:'no provider AQI'};
    const rootInfo = inspectRoot(body);
    if(!rootInfo.ok) return {patched:false, reason:`root ${rootInfo.reason}`};
    const airQ = getTableFieldTarget(body, rootInfo.root, 0);
    if(!airQ) return {patched:false, reason:'WK2 field0 airQuality missing'};
    const airInfo = inspectRootAt(body, airQ);
    if(!airInfo.ok) return {patched:false, reason:`airQuality ${airInfo.reason}`};
    // iOS27 WK2.AirQuality root table observed from native samples:
    // field2 @ object offset 16 = AQI integer, field1 @ offset 19 = categoryIndex.
    // Do not rebuild FlatBuffer. Only patch fixed-width scalar bytes in-place.
    const aqiOff = getFieldOffset(body, airQ, 2);
    const catOff = getFieldOffset(body, airQ, 1);
    if(!aqiOff) return {patched:false, reason:'AQI scalar field missing'};
    const oldAqi = u16(body, airQ + aqiOff);
    const oldCat = catOff ? body[airQ + catOff] : 0;
    setU16(body, airQ + aqiOff, aqi);
    const cat = aqiCategoryIndex(aqi);
    if(catOff) body[airQ + catOff] = cat & 255;
    return {patched:true, oldAqi, newAqi:Math.round(aqi), oldCat, newCat:cat, provider:aq.provider || ''};
  }
  function inspectRootAt(b, root){
    if(!b || root<4 || root+4>b.length) return {ok:false,reason:'bad table pos'};
    const vt=root-i32(b,root); if(vt<0 || vt+4>b.length) return {ok:false,reason:`bad vtable ${vt}`};
    const vtLen=u16(b,vt), objSize=u16(b,vt+2); if(vtLen<4 || vtLen>512 || vt+vtLen>b.length) return {ok:false,reason:`bad vtLen ${vtLen}`};
    const n=(vtLen-4)>>1, present=[]; for(let i=0;i<n;i++){ if(u16(b,vt+4+i*2)) present.push(i); }
    return {ok:true,root,vt,vtLen,objSize,fieldCount:n,present};
  }
  function locFromUrl(url){
    const u=new URL(url); const m=u.pathname.match(/\/api\/v2\/weather\/[^/]+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    if(!m) throw new Error('no lat/lon in WeatherKit URL');
    return {lat:Number(m[1]), lon:Number(m[2]), locale:(u.pathname.split('/')[4]||''), timezone:u.searchParams.get('timezone')||'', country:u.searchParams.get('country')||''};
  }
  function keyOf(loc){ return `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`; }
  function storeSet(k,v){ try{ if(typeof $persistentStore!=='undefined') $persistentStore.write(JSON.stringify(v), k); }catch(e){ log('WARN',`store write fail ${k}: ${e}`); } }
  function storeGet(k){ try{ if(typeof $persistentStore==='undefined') return null; const s=$persistentStore.read(k); return s?JSON.parse(s):null; }catch(_){ return null; } }
  function now(){ return Date.now(); }
  function isFresh(x,ttl){ return x && x.savedAt && (Date.now() - x.savedAt) < ttl*1000; }
  function getJSON(url, headers, timeout){
    return new Promise((resolve,reject)=>{
      const req = {url, headers: headers || {}};
      const timer = setTimeout(()=>reject(new Error('timeout')), timeout || 8000);
      $httpClient.get(req, (err, resp, data) => {
        clearTimeout(timer);
        if(err) return reject(err);
        const status = resp && resp.status;
        if(status && (status<200 || status>=300)) return reject(new Error(`HTTP ${status}`));
        try{ resolve(typeof data === 'string' ? JSON.parse(data) : data); }catch(e){ reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
  }
  function chooseProvider(kind){
    const wanted = String(ARG[kind==='nextHour'?'NextHour.Provider':'AirQuality.Provider']||'Auto');
    if(wanted !== 'Auto') return wanted;
    if(kind==='nextHour'){
      if(ARG['API.QWeather.Token']) return 'QWeather';
      if(ARG['API.ColorfulClouds.Token']) return 'ColorfulClouds';
      return 'WeatherKit';
    }
    if(ARG['API.WAQI.Token']) return 'WAQI';
    if(ARG['API.QWeather.Token']) return 'QWeather';
    if(ARG['API.ColorfulClouds.Token']) return 'ColorfulClouds';
    return 'WeatherKit';
  }
  function num(x){ const n=Number(x); return Number.isFinite(n)?n:null; }
  function cleanPollutants(p){
    const out={};
    [['pm25',['pm25','pm2p5','pm2_5']],['pm10',['pm10']],['o3',['o3']],['no2',['no2']],['so2',['so2']],['co',['co']]].forEach(([std,keys])=>{
      for(const k of keys){ if(p && p[k] != null){ const v = (typeof p[k] === 'object' && p[k].v != null) ? p[k].v : p[k]; const n=num(v); if(n!=null){out[std]=n; break;} } }
    });
    return out;
  }
  function categoryCN(aqi){
    aqi=num(aqi); if(aqi==null) return ''; if(aqi<=50)return '优'; if(aqi<=100)return '良'; if(aqi<=150)return '轻度污染'; if(aqi<=200)return '中度污染'; if(aqi<=300)return '重度污染'; return '严重污染';
  }
  function normalizeMinutes(list, provider){
    return (list||[]).slice(0,120).map((x,i)=>{
      const time = x.fxTime || x.datetime || x.time || x.date || null;
      let precip = x.precip ?? x.precipitation ?? x.value ?? x.intensity ?? x.rain;
      let prob = x.prob ?? x.probability ?? x.precipitationProbability ?? null;
      return { index:i, time: time ? String(time) : null, precipMmH: num(precip) ?? 0, probability: num(prob), type: String(x.type || x.precipType || x.weather || provider || '') };
    });
  }
  async function fetchCaiyun(loc, kinds){
    const token=ARG['API.ColorfulClouds.Token']; if(!token) throw new Error('missing ColorfulClouds token');
    const url=`https://api.caiyunapp.com/v2.6/${encodeURIComponent(token)}/${loc.lon},${loc.lat}/weather?lang=zh_CN&unit=metric:v2&alert=false&dailysteps=10&hourlysteps=72`;
    const j=await getJSON(url, {'Accept':'application/json'}, 10000);
    const r=j && j.result || {};
    const out={provider:'ColorfulClouds', rawStatus:j.status || j.error || ''};
    if(kinds.nextHour){
      const arr = (r.minutely && (r.minutely.precipitation_2h || r.minutely.precipitation)) || [];
      out.nextHour = { provider:'ColorfulClouds', summary:r.minutely && r.minutely.description || '', minutes:normalizeMinutes(arr.map((v,i)=>({value:v,index:i})), 'ColorfulClouds') };
    }
    if(kinds.airQuality){
      const aq = r.realtime && r.realtime.air_quality || {};
      const aqiObj = aq.aqi || {};
      const aqi = num(aqiObj.chn ?? aqiObj.usa ?? aqiObj.value ?? aq.aqi);
      out.airQuality = { provider:'ColorfulClouds', aqi, scale: aqiObj.chn!=null?'CN':(aqiObj.usa!=null?'US':''), category:categoryCN(aqi), primary:'', pollutants:cleanPollutants(aq), updatedAt:new Date().toISOString() };
    }
    return out;
  }
  async function fetchQWeatherMinutely(loc){
    const token=ARG['API.QWeather.Token']; if(!token) throw new Error('missing QWeather token');
    const host=(ARG['API.QWeather.Host']||'devapi.qweather.com').replace(/^https?:\/\//,'').replace(/\/+$/,'');
    const url=`https://${host}/v7/minutely/5m?location=${loc.lon},${loc.lat}&key=${encodeURIComponent(token)}`;
    const j=await getJSON(url, {'Accept':'application/json'}, 10000);
    if(j.code && !/^2/.test(String(j.code))) throw new Error(`QWeather minutely code=${j.code}`);
    return { provider:'QWeather', summary:j.summary || '', minutes:normalizeMinutes(j.minutely || [], 'QWeather'), updatedAt:j.updateTime || new Date().toISOString() };
  }
  async function fetchQWeatherAQI(loc){
    const token=ARG['API.QWeather.Token']; if(!token) throw new Error('missing QWeather token');
    const host=(ARG['API.QWeather.Host']||'devapi.qweather.com').replace(/^https?:\/\//,'').replace(/\/+$/,'');
    const url=`https://${host}/v7/air/now?location=${loc.lon},${loc.lat}&key=${encodeURIComponent(token)}`;
    const j=await getJSON(url, {'Accept':'application/json'}, 10000);
    if(j.code && !/^2/.test(String(j.code))) throw new Error(`QWeather air code=${j.code}`);
    const n=j.now || {};
    const aqi=num(n.aqi);
    return { provider:'QWeather', aqi, scale:'CN', category:n.category || categoryCN(aqi), primary:n.primary || '', pollutants:cleanPollutants(n), updatedAt:n.pubTime || j.updateTime || new Date().toISOString() };
  }
  async function fetchWAQI(loc){
    const token=ARG['API.WAQI.Token']; if(!token) throw new Error('missing WAQI token');
    const url=`https://api.waqi.info/feed/geo:${loc.lat};${loc.lon}/?token=${encodeURIComponent(token)}`;
    const j=await getJSON(url, {'Accept':'application/json'}, 10000);
    if(j.status !== 'ok') throw new Error(`WAQI status=${j.status || 'unknown'}`);
    const d=j.data || {}; const aqi=num(d.aqi);
    return { provider:'WAQI', aqi, scale:'WAQI', category:categoryCN(aqi), primary:d.dominentpol || '', pollutants:cleanPollutants(d.iaqi || {}), city:d.city && d.city.name || '', updatedAt:d.time && (d.time.iso || d.time.s) || new Date().toISOString() };
  }
  async function getProviderBundle(loc){
    const ttl=Math.max(30, Number(ARG['Provider.CacheTTL']||300));
    const cacheKey=`WeatherKit.iOS27.ProviderCache.${keyOf(loc)}`;
    const cached=storeGet(cacheKey); if(isFresh(cached, ttl)){ log('INFO',`provider cache hit ${keyOf(loc)} age=${Math.round((Date.now()-cached.savedAt)/1000)}s`); return cached; }
    const nextProvider = chooseProvider('nextHour');
    const aqProvider = chooseProvider('airQuality');
    const bundle={ savedAt:Date.now(), location:loc, selected:{nextHour:nextProvider, airQuality:aqProvider}, nextHour:null, airQuality:null, errors:[] };
    const jobs=[];
    if(nextProvider==='QWeather') jobs.push(fetchQWeatherMinutely(loc).then(v=>bundle.nextHour=v).catch(e=>bundle.errors.push(`QWeather nextHour: ${e.message||e}`)));
    if(nextProvider==='ColorfulClouds') jobs.push(fetchCaiyun(loc,{nextHour:true,airQuality:false}).then(v=>bundle.nextHour=v.nextHour).catch(e=>bundle.errors.push(`ColorfulClouds nextHour: ${e.message||e}`)));
    if(aqProvider==='QWeather') jobs.push(fetchQWeatherAQI(loc).then(v=>bundle.airQuality=v).catch(e=>bundle.errors.push(`QWeather AQI: ${e.message||e}`)));
    if(aqProvider==='WAQI') jobs.push(fetchWAQI(loc).then(v=>bundle.airQuality=v).catch(e=>bundle.errors.push(`WAQI AQI: ${e.message||e}`)));
    if(aqProvider==='ColorfulClouds') jobs.push(fetchCaiyun(loc,{nextHour:false,airQuality:true}).then(v=>bundle.airQuality=v.airQuality).catch(e=>bundle.errors.push(`ColorfulClouds AQI: ${e.message||e}`)));
    await Promise.all(jobs);
    storeSet(cacheKey, bundle);
    return bundle;
  }
  async function main(){
    const ct=hget($response.headers,'Content-Type');
    if(!/application\/vnd\.apple\.flatbuffer/i.test(ct) || !/WK2\.Weather/i.test(ct)){ log('DEBUG',`skip content-type=${ct}`); $done({}); return; }
    const loc=locFromUrl($request.url);
    const body=asU8($response.body);
    const info=inspectRoot(body);
    if(info.ok) log('INFO',`WK2.Weather ${keyOf(loc)} len=${body.length} fields=${info.fieldCount} present=[${info.present.join(',')}]`);
    else log('WARN',`WK2 inspect fail: ${info.reason}`);

    const bundle=await getProviderBundle(loc);
    const nh = bundle.nextHour ? `${bundle.nextHour.provider} minutes=${(bundle.nextHour.minutes||[]).length} summary=${bundle.nextHour.summary||''}` : 'none';
    const aq = bundle.airQuality ? `${bundle.airQuality.provider} aqi=${bundle.airQuality.aqi} ${bundle.airQuality.category||''} primary=${bundle.airQuality.primary||''}` : 'none';
    log('INFO',`provider: nextHour=${nh}; airQuality=${aq}`);
    if(bundle.errors.length){ log('WARN',`provider errors: ${bundle.errors.join(' | ')}`); if(ARG.DebugNotify==='1') notify('WeatherKit Provider', '第三方源异常', bundle.errors.join('\n')); }

    let outBody = null;
    const mode = String(ARG['Provider.PatchMode'] || 'Preserve').toLowerCase();
    if(mode !== 'preserve'){
      const patched = patchAirQualityInPlace(body, bundle);
      if(patched.patched){
        outBody = body;
        log('WARN',`injectAQI: ${patched.oldAqi}/${patched.oldCat} -> ${patched.newAqi}/${patched.newCat} provider=${patched.provider || 'unknown'}; nextHour still preserve`);
      } else {
        log('WARN',`injectAQI skipped: ${patched.reason}; nextHour still preserve`);
      }
    }
    if(outBody) $done({ body: outBody }); else $done({});
  }
  main().catch(e=>{ console.log(`[${NAME}] ERROR ${e && e.stack || e}`); $done({}); });
})();
