const isPanel = () => typeof $input !== "undefined" && $input.purpose === "panel";

const arg = parseArgument(typeof $argument !== "undefined" ? $argument : "");

const TYPE = arg.TYPE || (isPanel() ? "PANEL" : "EVENT");
const DISMISS = toInt(arg.DISMISS, 2);
const COOLDOWN = toInt(arg.COOLDOWN, 30);
const FLUSH_DNS = arg.FLUSH_DNS === "1";
const DNS_FLUSH_DELAY = Math.max(0, toInt(arg.DNS_FLUSH_DELAY, 15));
const ICON = arg.ICON || "xmark.circle";
const ICON_COLOR = arg.ICON_COLOR || "#C5424A";

const STORE_NETWORK = "kill_connections_lite_last_network";
const STORE_TIME = "kill_connections_lite_last_time";
const STORE_DNS_FLUSH_AT = "kill_connections_lite_dns_flush_at";

(async () => {
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

  $done({});
})().catch((e) => {
  const msg = e && e.message ? e.message : String(e);

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
  if ($trigger !== "button") {
    const pendingAt = toInt($persistentStore.read(STORE_DNS_FLUSH_AT), 0);
    const pendingText =
      pendingAt > Date.now()
        ? `\n待刷新 DNS：${formatTime(pendingAt)}`
        : "";

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

  if (now - lastTime < COOLDOWN * 1000) {
    $done({});
    return;
  }

  const current = getNetworkState();
  const previous = safeJSONParse($persistentStore.read(STORE_NETWORK), null);

  $persistentStore.write(JSON.stringify(current), STORE_NETWORK);

  if (!previous) {
    $done({});
    return;
  }

  const mode = arg.EVENT_MODE || "wifi-change";
  const shouldKill = shouldKillByMode(previous, current, mode);

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

  $done({});
}

async function runDNSFlusher() {
  const flushAt = toInt($persistentStore.read(STORE_DNS_FLUSH_AT), 0);

  if (!flushAt) {
    $done({});
    return;
  }

  if (Date.now() < flushAt) {
    $done({});
    return;
  }

  $persistentStore.write("", STORE_DNS_FLUSH_AT);

  await httpAPI("/v1/dns/flush", "POST");

  $done({});
}

function scheduleDNSFlushIfNeeded() {
  if (!FLUSH_DNS) return;

  const flushAt = Date.now() + DNS_FLUSH_DELAY * 1000;
  $persistentStore.write(String(flushAt), STORE_DNS_FLUSH_AT);
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

  let tempModes;

  if (beforeMode === "direct") {
    tempModes = ["proxy", "direct"];
  } else if (beforeMode === "proxy") {
    tempModes = ["direct", "proxy"];
  } else {
    tempModes = ["proxy", "direct", "rule"];
  }

  for (const mode of tempModes) {
    await httpAPI("/v1/outbound", "POST", { mode });
    await sleep(120);
  }

  await httpAPI("/v1/outbound", "POST", { mode: beforeMode });
  await sleep(120);

  const after = await httpAPI("/v1/outbound", "GET");

  if (!after || after.mode !== beforeMode) {
    await httpAPI("/v1/outbound", "POST", { mode: beforeMode });
  }

  return beforeMode;
}

function httpAPI(path, method, body) {
  return new Promise((resolve) => {
    $httpAPI(method, path, body || null, (result) => {
      resolve(result || {});
    });
  });
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

function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  const pad = (n) => String(n).padStart(2, "0");

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}