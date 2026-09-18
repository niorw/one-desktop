#!/usr/bin/env bash
# CSS token 白名单门禁：校验组件 CSS 里 var(--xxx) 引用的每个 token
# 都在 App.css 的 :root / [data-theme="dark"] 中定义过，或属于本地注入型白名单。
# 防止再造「悬空 token」（声明整体失效）——历史教训见 .workbuddy/memory（--border-subtle 等 30+ 处）。
#
# 用法：bash scripts/check-css-tokens.sh
# 本地注入型 token（tsx 里 style={{ "--x": v }} 注入，不定义在 App.css）：在此白名单登记。
set -u
cd "$(dirname "$0")/../src" || exit 1

APP_CSS="App.css"

# 1) 收集已定义 token：全局库 + 组件局部定义（含「选择器同行内联定义」，如 .kb-col { --kb-dot: ... }）
defined=$(grep -rhoE --include="*.css" -- '--[a-z0-9-]+:' . | tr -d ' :' | sort -u)

# 2) 本地注入型 token 白名单（tsx style 注入，见 tsx 内 `"--sb-w"` 等）
injected="
--sb-w
--w-acc
--w-acc-dark
"

# 3) 扫描全部组件 CSS 的 var(--xxx) 引用
refs=$(grep -rhoE --include="*.css" -- 'var\(--[a-z0-9-]+' . | sed 's/var(//' | sort -u)

# 4) 找未定义且不在白名单的
missing=0
for t in $refs; do
  if ! echo "$defined" | grep -qxF -- "$t" && ! echo "$injected" | grep -qxF -- "$t"; then
    echo "未定义 token: $t"
    missing=1
  fi
done

if [ "$missing" -eq 0 ]; then
  echo "OK: 全部 var(--*) 均有定义或属本地注入白名单"
else
  echo "失败：存在悬空 token（声明会整体失效）。在 App.css 定义或登记白名单。"
fi
exit "$missing"
