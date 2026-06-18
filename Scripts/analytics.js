/* WeatherKit iOS27 Provider Adapter - analytics.js */
(() => {
  const LEVEL = { OFF:0, ERROR:1, WARN:2, INFO:3, DEBUG:4, ALL:5 };
  function arg(s){const o={LogLevel:'INFO',StripAnalytics:'0'};(s||'').split('&').forEach(p=>{const i=p.indexOf('=');if(i>0){o[decodeURIComponent(p.slice(0,i))]=decodeURIComponent(p.slice(i+1)).replace(/^"|"$/g,'');}});return o;}
  const ARG=arg(typeof $argument==='string'?$argument:'');
  const LOG=LEVEL[String(ARG.LogLevel||'INFO').toUpperCase()]??3;
  if(LOG>=LEVEL.DEBUG) console.log(`[WK27.Provider.analytics] ${$request.method||'GET'} ${$request.url}`);
  if(ARG.StripAnalytics==='1') $done({response:{status:204,headers:{'Cache-Control':'no-store'},body:''}}); else $done({});
})();
