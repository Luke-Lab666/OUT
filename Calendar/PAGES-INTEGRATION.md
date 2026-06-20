# ProxyKit 首页接入：日历分类卡片

目标：在首页筛选按钮里显示：

```text
全部｜规则｜脚本｜模块｜日历
```

点击「日历」时，只显示一个主题适配的日历订阅卡片；「全部」仍然只显示规则、脚本、模块，不混入日历。

## 1. 保留 Calendar 文件目录

把这些文件合并进仓库：

```text
Calendar/
  cn-mainland-holidays-2026-cn-full-v2.ics
  README.md
  data/cn-mainland-holidays-2026-cn-full-v2.json
  scripts/build_calendar.py
.github/workflows/update-calendar.yml
```

## 2. 把两个前端文件放进 docs

```text
docs/calendar-category.css
docs/calendar-category.js
```

## 3. 修改 docs/index.html

在 `</head>` 前加：

```html
<link rel="stylesheet" href="./calendar-category.css">
```

在你现有主 `<script>...</script>` 后、`</body>` 前加：

```html
<script src="./calendar-category.js"></script>
```

不需要把 `Calendar` 加进原来的 `FOLDERS`，否则「全部」会把 `.ics` 当普通文件显示。这个方案是前端单独接管日历分类。

## 4. 如果你想手动写按钮，也可以这样

在模块按钮后加：

```html
<button class="chip" data-folder="Calendar">日历</button>
```

顶部导航模块后加：

```html
<a href="#calendar" data-jump-calendar>日历</a>
```

不过 `calendar-category.js` 已经会自动补这两个入口，所以不手动加也行。

## 5. Actions / Pages 路径

如果 Pages workflow 有 paths 触发过滤，加入：

```yaml
- "Calendar/**"
- "docs/calendar-category.css"
- "docs/calendar-category.js"
```

## 6. 文案

标题固定为：

```text
中国大陆节假日与中国纪念日 2026
```
