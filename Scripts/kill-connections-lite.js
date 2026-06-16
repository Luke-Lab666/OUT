const isPanel = () => typeof $input !== "undefined" && $input.purpose === "panel";

const arg = parseArgument(typeof $argument !== "undefined" ? $argument : "");

const TYPE = arg.TYPE || (isPanel() ? "PANEL" : "EVENT");
const DISMISS = toInt(arg.DISMISS, 2);
const COOLDOWN = toInt(arg.COOLDOWN, 30);
const FLUSH_DNS = arg.FLUSH_DNS === "1";
const DNS_FLUSH_DELAY = Math.max(0, toInt(arg.DNS_FLUSH_DELAY, 30));
const LOG = toInt(arg.LOG, 0);
const ICON = arg.ICON || "xmark.circle";
const ICON_COLOR = arg.ICON_COLOR || "#C5424A";

const STORE_NETWORK = "kill_connections_lite_last_network";
const STORE_TIME = "kill_connections_lite_last_time";
const STORE_DNS_FLUSH_AT = "kill_connections_lite_dns_flush_at";

(async () => {
  log(1, `启动：TYPE=${TYPE}, LOG=${LOG}`);

  if (TYPE === "PANEL") {
    await runPanel();
    return;
  }

  if (TYPE === "EVENT") {
    await runEvent();
    return;
  }

  if (TYPE === "DNS_FLUSHER") {
    await runDNSFlusher();
    return;
  }

  log(1, `未知 TYPE：${TYPE}`);
  $done({});
})().catch((e) => {
  const msg = e && e.message ? e.message : String(e);
  log(1, `异常：${msg}`);

  if (isPanel()) {
    $done({
      title: "打断失败",
      content: msg,
      icon: "xmark.octagon",
      "icon-color": "#C5424A",
    });
  } else {
    $notification.post("Surge", "低内存打断脚本失败", msg, {
      "auto-dismiss": DISMISS,
    });
    $done({});
  }
});

async function runPanel() {
  log(1, "进入面板模式");

  if ($trigger !== "button") {
    const pendingAt = toInt($persistentStore.read(STORE_DNS_FLUSH_AT), 0);
    const pendingText =
      pendingAt > Date.now()
        ? `\n待刷新 DNS：${formatTime(pendingAt)}`
        : "";

    log(2, `面板刷新，pendingAt=${pendingAt}`);

    $done({
      title: "低内存打断连接",
      content:
        "点击按钮执行打断连接\n网络变化自动打断由 Event 脚本处理" + pendingText,
      icon: ICON,
      "icon-color": ICON_COLOR,
    });
    return;
  }

  const beforeMode = await killConnections();

  scheduleDNSFlushIfNeeded();

  const dnsText = FLUSH_DNS
    ? `\nDNS 将在 ${DNS_FLUSH_DELAY} 秒后由定时脚本刷新`
    : "\nDNS 刷新已关闭";

  log(1, `面板打断完成，恢复模式=${beforeMode}，FLUSH_DNS=${FLUSH_DNS}`);

  $notification.post(
    "Surge",
    "已打断连接",
    `已恢复出站模式：${beforeMode}${dnsText}`,
    { "auto-dismiss": DISMISS }
  );

  $done({
    title: "已打断连接",
    content: `已恢复出站模式：${beforeMode}${dnsText}\n${formatTime()}`,
    icon: ICON,
    "icon-color": ICON_COLOR,
  });
}

async function runEvent() {
  const now = Date.now();
  const lastTime = toInt($persistentStore.read(STORE_TIME), 0);

  log(1, "进入网络变化事件模式");

  if (now - lastTime < COOLDOWN * 1000) {
    log(1, `冷却中，剩余约 ${Math.ceil((COOLDOWN * 1000 - (now - lastTime)) / 1000)} 秒`);
    $done({});
    return;
  }

  const current = getNetworkState();
  const previous = safeJSONParse($persistentStore.read(STORE_NETWORK), null);

  log(2, `当前网络：${JSON.stringify(current)}`);
  log(2, `上次网络：${JSON.stringify(previous)}`);

  $persistentStore.write(JSON.stringify(current), STORE_NETWORK);

  if (!previous) {
    log(1, "首次记录网络状态，不执行打断");
    $done({});
    return;
  }

  const mode = arg.EVENT_MODE || "wifi-change";
  const shouldKill = shouldKillByMode(previous, current, mode);

  log(1, `EVENT_MODE=${mode}, shouldKill=${shouldKill}`);

  if (!shouldKill) {
    $done({});
    return;
  }

  $persistentStore.write(String(now), STORE_TIME);

  const beforeMode = await killConnections();

  scheduleDNSFlushIfNeeded();

  if (arg.EVENT_NOTIFY === "1") {
    const dnsText = FLUSH_DNS
      ? `\nDNS 将在 ${DNS_FLUSH_DELAY} 秒后刷新`
      : "\nDNS 刷新已关闭";

    $notification.post(
      "Surge",
      "网络变化，已自动打断连接",
      `模式：${mode}\n已恢复出站模式：${beforeMode}${dnsText}`,
      { "auto-dismiss": DISMISS }
    );
  }

  log(1, `事件打断完成，恢复模式=${beforeMode}`);
  $done({});
}

async function runDNSFlusher() {
  const flushAt = toInt($persistentStore.read(STORE_DNS_FLUSH_AT), 0);

  log(2, `DNS_FLUSHER 检查，flushAt=${flushAt}, now=${Date.now()}`);

  if (!flushAt) {
    log(2, "没有待刷新 DNS 任务");
    $done({});
    return;
  }

  if (Date.now() < flushAt) {
    log(1, `DNS 刷新未到时间，预计：${formatTime(flushAt)}`);
    $done({});
    return;
  }

  $persistentStore.write("", STORE_DNS_FLUSH_AT);

  await httpAPI("/v1/dns/flush", "POST");

  log(1, "已执行 DNS Flush");
  $done({});
}

function scheduleDNSFlushIfNeeded() {
  if (!FLUSH_DNS) {
    log(1, "FLUSH_DNS=0，不安排 DNS 刷新");
    return;
  }

  const flushAt = Date.now() + DNS_FLUSH_DELAY * 1000;
  $persistentStore.write(String(flushAt), STORE_DNS_FLUSH_AT);

  log(1, `已安排 DNS Flush：${formatTime(flushAt)}`);
}

function shouldKillByMode(previous, current, mode) {
  if (mode === "wifi-lost") {
    return previous.hasWifi && !current.hasWifi;
  }

  if (mode === "wifi-change") {
    if (previous.hasWifi && !current.hasWifi) return true;
    if (!previous.hasWifi && current.hasWifi) return true;
    return Boolean(previous.wifiId && current.wifiId && previous.wifiId !== current.wifiId);
  }

  return previous.key !== current.key;
}

function getNetworkState() {
  const network = typeof $network !== "undefined" ? $network : {};
  const wifi = network.wifi || {};
  const cellular = network.cellular || {};
  const v4 = network.v4 || {};
  const v6 = network.v6 || {};

  const wifiId = wifi.bssid || wifi.ssid || "";
  const cellularId = cellular.carrier || cellular.radio || "";
  const primaryV4 = v4.primaryInterface || "";
  const primaryV6 = v6.primaryInterface || "";

  const key = [
    `wifi:${wifiId}`,
    `cellular:${cellularId}`,
    `v4:${primaryV4}`,
    `v6:${primaryV6}`,
  ].join("|");

  return {
    key,
    hasWifi: Boolean(wifiId),
    wifiId,
    cellularId,
    primaryV4,
    primaryV6,
  };
}

async function killConnections() {
  const outbound = await httpAPI("/v1/outbound", "GET");
  const beforeMode = outbound && outbound.mode ? outbound.mode : "rule";

  log(1, `开始打断连接，当前出站模式=${beforeMode}`);

  let tempModes;

  if (beforeMode === "direct") {
    tempModes = ["proxy", "direct"];
  } else if (beforeMode === "proxy") {
    tempModes = ["direct", "proxy"];
  } else {
    tempModes = ["proxy", "direct", "rule"];
  }

  log(2, `临时切换序列=${JSON.stringify(tempModes)}`);

  for (const mode of tempModes) {
    log(2, `切换出站模式：${mode}`);
    await httpAPI("/v1/outbound", "POST", { mode });
    await sleep(120);
  }

  log(2, `恢复出站模式：${beforeMode}`);
  await httpAPI("/v1/outbound", "POST", { mode: beforeMode });
  await sleep(120);

  const after = await httpAPI("/v1/outbound", "GET");

  if (!after || after.mode !== beforeMode) {
    log(1, `模式恢复校验失败，再次恢复：${beforeMode}`);
    await httpAPI("/v1/outbound", "POST", { mode: beforeMode });
  }

  log(1, "打断连接完成");
  return beforeMode;
}

function httpAPI(path, method, body) {
  log(2, `HTTP API ${method} ${path}`);

  return new Promise((resolve) => {
    $httpAPI(method, path, body || null, (result) => {
      log(2, `HTTP API 返回 ${path}: ${safeStringify(result)}`);
      resolve(result || {});
    });
  });
}

function log(level, message) {
  if (LOG < level) return;
  console.log(`[KillConnectionsLite] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgument(argument) {
  const result = {};
  if (!argument) return result;

  for (const item of argument.split("&")) {
    const index = item.indexOf("=");

    if (index === -1) continue;

    const key = decodeURIComponent(item.slice(0, index));
    const value = decodeURIComponent(item.slice(index + 1));

    result[key] = value;
  }

  return result;
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function safeJSONParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  const pad = (n) => String(n).padStart(2, "0");

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
