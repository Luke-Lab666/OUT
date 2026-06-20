#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CAL_DIR = ROOT / "Calendar"
DATA_DIR = CAL_DIR / "data"
OWNER = "Luke-Lab666"
REPO = "ProxyKit"
BRANCH = "main"

CATEGORY_ORDER = ["放假", "调休上班", "传统节日", "节气", "纪念日", "亲情纪念日"]


def esc(value: str) -> str:
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace(";", r"\;")
        .replace(",", r"\,")
        .replace("\r\n", r"\n")
        .replace("\n", r"\n")
    )


def fold_line(line: str) -> str:
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    out: list[str] = []
    current = ""
    for ch in line:
        test = (current + ch).encode("utf-8")
        if len(test) > 73:
            out.append(current)
            current = " " + ch
        else:
            current += ch
    if current:
        out.append(current)
    return "\r\n".join(out)


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9._-]+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-")
    return value or "calendar"


def uid_for(slug: str, event: dict[str, Any]) -> str:
    seed = f"{slug}|{event.get('start','')}|{event.get('end','')}|{event.get('summary','')}"
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]
    return f"{digest}@{REPO.lower()}.calendar"


def group_counts(events: list[dict[str, Any]]) -> dict[str, int]:
    counter = Counter(str(event.get("category") or "其他") for event in events)
    ordered: dict[str, int] = {}
    for key in CATEGORY_ORDER:
        if key in counter:
            ordered[key] = counter.pop(key)
    for key in sorted(counter):
        ordered[key] = counter[key]
    return ordered


def build_ics(data: dict[str, Any], slug: str) -> str:
    calendar_name = data.get("calendar_name") or slug
    timezone = data.get("timezone") or "Asia/Shanghai"
    description = data.get("description") or ""
    events = data.get("events") or []
    dtstamp = "20260101T000000Z"  # deterministic: unchanged data will not create noisy commits

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Luke-Lab666//ProxyKit Calendar//CN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{esc(calendar_name)}",
        f"X-WR-CALDESC:{esc(description)}",
        f"X-WR-TIMEZONE:{esc(timezone)}",
    ]

    for event in sorted(events, key=lambda e: (str(e.get("start", "")), str(e.get("summary", "")))):
        start = str(event["start"])
        end = str(event.get("end") or event["start"])
        summary = str(event.get("summary") or "")
        desc = str(event.get("description") or "")
        category = str(event.get("category") or "")
        transparency = str(event.get("transparency") or "TRANSPARENT")
        lines.extend([
            "BEGIN:VEVENT",
            f"UID:{uid_for(slug, event)}",
            f"DTSTAMP:{dtstamp}",
            f"DTSTART;VALUE=DATE:{start}",
            f"DTEND;VALUE=DATE:{end}",
            f"SUMMARY:{esc(summary)}",
            f"DESCRIPTION:{esc(desc)}",
            f"CATEGORIES:{esc(category)}",
            f"TRANSP:{esc(transparency)}",
            "END:VEVENT",
        ])

    lines.append("END:VCALENDAR")
    return "\r\n".join(fold_line(line) for line in lines) + "\r\n"


def build_readme(outputs: list[dict[str, Any]]) -> str:
    lines = [
        "# Calendar",
        "",
        "中国大陆节假日 / 调休 / 中国传统节日 / 二十四节气 / 中国常用纪念日订阅日历。",
        "",
        "> 官方放假和调休以国务院办公厅发布为准；未来年份发布后，把对应年份 JSON 加到 `Calendar/data/`，Action 会自动生成新的 `.ics`。",
        "",
        "## 订阅链接",
        "",
    ]
    for item in outputs:
        raw = f"https://raw.githubusercontent.com/{OWNER}/{REPO}/{BRANCH}/Calendar/{item['filename']}"
        webcal = raw.replace("https://", "webcal://", 1)
        counts_text = "、".join(f"{k} {v}" for k, v in item["counts"].items())
        lines.extend([
            f"### {item['calendar_name']}",
            "",
            f"- iOS 订阅：`{webcal}`",
            f"- Raw .ics：`{raw}`",
            f"- 事件数：{item['count']}",
            f"- 分类：{counts_text}",
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    outputs: list[dict[str, Any]] = []
    json_files = sorted(DATA_DIR.glob("*.json"))
    if not json_files:
        raise SystemExit("No JSON files found in Calendar/data")

    for path in json_files:
        data = json.loads(path.read_text(encoding="utf-8"))
        slug = slugify(data.get("slug") or path.stem)
        filename = f"{slug}.ics"
        events = sorted(data.get("events", []), key=lambda e: (e.get("start", ""), e.get("summary", "")))
        data["events"] = events
        (CAL_DIR / filename).write_text(build_ics(data, slug), encoding="utf-8", newline="")
        outputs.append({
            "filename": filename,
            "calendar_name": data.get("calendar_name") or slug,
            "description": data.get("description") or "",
            "count": len(events),
            "counts": group_counts(events),
        })

    (CAL_DIR / "README.md").write_text(build_readme(outputs), encoding="utf-8")
    print("Built calendar files: " + ", ".join(item["filename"] for item in outputs))


if __name__ == "__main__":
    main()
