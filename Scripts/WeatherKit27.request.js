/*
 * WeatherKit27.request.js
 * iOS 27 WeatherKit request shim for Surge.
 * - Ensures iOS27 weather request asks for all datasets used by Weather.app UI.
 * - Does not touch auth/clientMetadata.
 */
(() => {
  const NAME = 'WeatherKit27.request';
  const LEVEL = { OFF:0, ERROR:1, WARN:2, INFO:3, DEBUG:4, ALL:5 };
  const DEFAULT = {
    ForceAllDataSets: '1',
    LogLevel: 'INFO',
  };
  function parseArgs(s) {
    const out = Object.assign({}, DEFAULT);
    String(s || '').split('&').forEach(p => {
      const i = p.indexOf('=');
      if (i > 0) out[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1)).replace(/^"|"$/g, '');
    });
    return out;
  }
  const ARG = parseArgs(typeof $argument === 'string' ? $argument : '');
  const LOG = LEVEL[String(ARG.LogLevel || 'INFO').toUpperCase()] ?? 3;
  function log(l, m) { if (LOG >= LEVEL[l]) console.log(`[${NAME}] ${m}`); }

  try {
    const url = new URL($request.url);
    if (!/\/api\/v2\/weather\//.test(url.pathname)) return $done({});

    if (ARG.ForceAllDataSets === '1') {
      const must = [
        'airQuality',
        'currentWeather',
        'dataNotice',
        'forecastDaily',
        'forecastHourly',
        'forecastNextHour',
        'forecastPeriodic',
        'highlights',
        'news',
        'historicalComparisons',
        'weatherAlerts',
        'weatherChanges'
      ];
      const old = (url.searchParams.get('dataSets') || '').split(',').map(x => x.trim()).filter(Boolean);
      const merged = Array.from(new Set([...old, ...must]));
      url.searchParams.set('dataSets', merged.join(','));
      log('INFO', `dataSets=${merged.join(',')}`);
      return $done({ url: url.toString() });
    }
    return $done({});
  } catch (e) {
    log('ERROR', e && e.stack || String(e));
    return $done({});
  }
})();
