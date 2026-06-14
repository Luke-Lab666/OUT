const isPanel = () => typeof $input !== "undefined" && $input.purpose === "panel";

const arg = parseArgument(typeof $argument !== "undefined" ? $argument : "");

const TYPE = arg.TYPE || (isPanel() ? "PANEL" : "EVENT");
const DISMISS = toInt(arg.DISMISS, 2);
const COOLDOWN = toInt(arg.COOLDOWN, 5);
const FLUSH_DNS = arg.FLUSH_DNS !== "0";

const ICON = arg.ICON || "xmark.circle";
const ICON_COLOR = arg.ICON_COLOR || "#C5424A";

const STORE_NETWORK = "kill_connections_lite_last_network";
const STORE_TIME = "kill_connections_lite_last_time";

(async () => {
  if (TYPE === "PANEL") {
    await runPanel();
    return;
  }

  if (TYPE === "EVENT") {
    await runEvent();
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
    $notification.post("Surge", "自动打断失败", msg, { "auto-dismiss": DISMISS });
    $done({});
  }
});

async function runPanel() {
  if ($trigger !== "button") {
    $done({
      title: "低内存打断连接",
      content: "点击按钮执行\n网络变化自动打断已由 Event 脚本处理",
      icon: ICON,
      "icon-color": ICON_COLOR,
    });
    return;
  }

  const beforeMode = await killConnections();

  $notification.post(
    "Surge",
    "已打断连接",
    `已恢复出站模式：${beforeMode}`,
    { "auto-dismiss": DISMISS }
  );

  $done({
    title: "已打断连接",
    content: `已恢复出站模式：${beforeMode}\n${formatTime()}`,
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

  // 第一次记录网络状态，不打断，避免刚启用模块就误触发。
  if (!previous) {
    $done({});
    return;
  }

  const mode = arg.EVENT_MODE || "change";
  const shouldKill = shouldKillByMode(previous, current, mode);

  if (!shouldKill) {
    $done({});
    return;
  }

  $persistentStore.write(String(now), STORE_TIME);

  const beforeMode = await killConnections();

  if (arg.EVENT_NOTIFY === "1") {
    $notification.post(
      "Surge",
      "网络变化，已自动打断连接",
      `模式：${mode}\n已恢复出站模式：${beforeMode}`,
      { "auto-dismiss": DISMISS }
    );
  }

  $done({});
}

function shouldKillByMode(previous, current, mode) {
  if (mode === "wifi-lost") {
    return previous.hasWifi && !current.hasWifi;
  }

  if (mode === "wifi-change") {
    if (previous.hasWifi && !current.hasWifi) return true;
    if (!previous.hasWifi && current.hasWifi) return true;
    return previous.wifiId && current.wifiId && previous.wifiId !== current.wifiId;
  }

  // 默认：任意网络签名变化都打断
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
  if (FLUSH_DNS) {
    await httpAPI("/v1/dns/flush", "POST");
  }

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

function formatTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}