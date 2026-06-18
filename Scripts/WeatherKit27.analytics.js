/*
 * WeatherKit27.analytics.js
 * Optional Weather analytics pass/reject helper.
 */
(() => {
  const NAME = 'WeatherKit27.analytics';
  const DEFAULT = { StripAnalytics: '0', LogLevel: 'INFO' };
  const LEVEL = { OFF:0, ERROR:1, WARN:2, INFO:3, DEBUG:4, ALL:5 };
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
    log('DEBUG', `${$request.method || ''} ${$request.url}`);
    if (ARG.StripAnalytics === '1') return $done({ response: { status: 204, headers: {}, body: '' } });
    return $done({});
  } catch (_) {
    return $done({});
  }
})();
