/* WeatherKit iOS27 Provider Adapter - request.js */
(() => {
  const NAME = 'WK27.Provider.request';
  const DATASETS = [
    'airQuality','currentWeather','dataNotice','forecastDaily','forecastHourly',
    'forecastNextHour','forecastPeriodic','highlights','news','historicalComparisons',
    'weatherAlerts','weatherChanges'
  ];
  const LEVEL = { OFF:0, ERROR:1, WARN:2, INFO:3, DEBUG:4, ALL:5 };
  function arg(s){const o={ForceAllDataSets:'1',LogLevel:'INFO'};(s||'').split('&').forEach(p=>{const i=p.indexOf('=');if(i>0){let k=decodeURIComponent(p.slice(0,i));let v=decodeURIComponent(p.slice(i+1));o[k]=String(v).replace(/^"|"$/g,'');}});return o;}
  const ARG = arg(typeof $argument === 'string' ? $argument : '');
  const LOG = LEVEL[String(ARG.LogLevel||'INFO').toUpperCase()] ?? 3;
  function log(l,m){ if(LOG >= LEVEL[l]) console.log(`[${NAME}] ${m}`); }
  function mergeDataSets(s){
    const seen = Object.create(null), out = [];
    DATASETS.concat(String(s||'').split(',')).forEach(x=>{x=String(x||'').trim(); if(x && !seen[x]){seen[x]=1; out.push(x);}});
    return out.join(',');
  }
  function utcLocalMidnightShift(days){ const d=new Date(); d.setUTCDate(d.getUTCDate()+days); d.setUTCHours(16,0,0,0); return d.toISOString().replace(/\.000Z$/,'Z'); }
  try{
    const u = new URL($request.url); let changed=false;
    if(ARG.ForceAllDataSets !== '0'){
      const before = u.searchParams.get('dataSets') || '';
      const after = mergeDataSets(before);
      if(after !== before){ u.searchParams.set('dataSets', after); changed=true; log('INFO',`dataSets => ${after}`); }
    }
    if(!u.searchParams.has('relativeDailyStart')){u.searchParams.set('relativeDailyStart','-1');changed=true;}
    if(!u.searchParams.has('relativeDailyEnd')){u.searchParams.set('relativeDailyEnd','10');changed=true;}
    if(!u.searchParams.has('periodicStart')){u.searchParams.set('periodicStart',utcLocalMidnightShift(-1));changed=true;}
    if(!u.searchParams.has('periodicEnd')){u.searchParams.set('periodicEnd',utcLocalMidnightShift(9));changed=true;}
    if(!u.searchParams.has('periodLengths')){u.searchParams.set('periodLengths','2');changed=true;}
    if(changed) $done({url:u.toString()}); else $done({});
  }catch(e){ console.log(`[${NAME}] ERROR ${e && e.stack || e}`); $done({}); }
})();
