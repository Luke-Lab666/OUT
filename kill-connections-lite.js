const isPanel = () => typeof $input !== "undefined" && $input.purpose === "panel";

const arg = parseArgument(typeof $argument !== "undefined" ? $argument : "");

const ICON = arg.ICON || "xmark.circle";
const ICON_COLOR = arg["ICON-COLOR"] || "#C5424A";
const DISMISS = /^\d+$/.test(arg.DISMISS || "") ? parseInt(arg.DISMISS, 10) : 2;
const FLUSH_DNS = arg.FLUSH_DNS !== "0";

(async () => {
  if (!isPanel()) {
    return $done({});
  }

  if ($trigger !== "button") {
    return $done({
      title: "打断连接",
      content: "点击按钮执行\n低内存版：不统计活跃连接",
      icon: ICON,
      "icon-color": ICON_COLOR,
    });
  }

  const beforeMode = await killConnections();

  $notification.post(
    "Surge",
    "已打断连接",
    `已恢复出站模式：${beforeMode}`,
    { "auto-dismiss": DISMISS }
  );

  return $done({
    title: "已打断连接",
    content: `已恢复出站模式：${beforeMode}\n${formatTime()}`,
    icon: ICON,
    "icon-color": ICON_COLOR,
  });
})().catch((e) => {
  const msg = e && e.message ? e.message : String(e);

  $notification.post(
    "Surge",
    "打断连接失败",
    msg,
    { "auto-dismiss": DISMISS }
  );

  $done({
    title: "打断失败",
    content: msg,
    icon: "xmark.octagon",
    "icon-color": "#C5424A",
  });
});

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
    tempModes = ["proxy", "direct"];
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

function formatTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}