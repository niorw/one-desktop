#!/usr/bin/env bash
#
# check-kernel-purity.sh — T2 去 Tauri 化·内核纯净度守门员
#
# 内核层（agent / group / scheduler）必须不直接依赖 Tauri 运行时泛型
# `<R: Runtime>` / `AppHandle<R>` / `use tauri::`。唯一允许的 Tauri 依赖点是
# 适配层 `src-tauri/src/agent/ports.rs`（TauriObserver / TauriEventBus），
# 它在组合根把 Tauri 适配到内核端口（RunObserver / EventBus）。
#
# 退出码非 0 表示违反，供 pre-push 挂住推送。
# 注：不用 `set -u`（nounset）—— 与本环境 bash 沙箱包装存在交互异常，
# 会把已赋值变量误判为 unbound；`set -e` 足以在命令失败时中止。
set -eo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src-tauri/src"

# 内核目录（组合根 lib.rs / commands/ 不在其内；适配端口 ports.rs 单独豁免）
KERNEL_DIRS=("$SRC/agent" "$SRC/group" "$SRC/scheduler")
# 唯一被豁免的 Tauri 依赖点（相对 SRC 的路径）
ALLOWED="agent/ports.rs"

# 跳过注释行：grep -rn 输出为 `file:line:content`，文档注释的 `///` 在行中部冒号后，
# 故匹配 `:` 后可选空白再 `//`（不误伤代码里的 `http://` 等 URL）。
skip_comments() { grep -vE ':[[:space:]]*//' || true; }

fail=0

echo "== 内核纯净度检查：禁止 'use tauri::'（除 $ALLOWED）=="
hits=$(grep -rnE 'use[[:space:]]+tauri::' "${KERNEL_DIRS[@]}" 2>/dev/null \
        | grep -vF "$ALLOWED" \
        | skip_comments || true)
if [ -n "$hits" ]; then
  echo "FAIL: 内核层不得 'use tauri::'（仅 $ALLOWED 允许）："
  echo "$hits"
  fail=1
fi

echo "== 内核纯净度检查：禁止 Tauri 运行时泛型 R: Runtime / AppHandle<_> / <R:（除 $ALLOWED）=="
hits2=$(grep -rnE 'R:[[:space:]]*Runtime|AppHandle<|<R:' "${KERNEL_DIRS[@]}" 2>/dev/null \
        | grep -vF "$ALLOWED" \
        | skip_comments || true)
if [ -n "$hits2" ]; then
  echo "FAIL: 内核层不得出现 Tauri 运行时泛型（仅 $ALLOWED 允许）："
  echo "$hits2"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "内核纯净度检查未通过。若有意为之，请在 ports.rs 适配层实现，"
  echo "并保持本脚本的 ALLOWED 不变；否则移除内核层对 Tauri 的直接依赖。"
  exit 1
fi

echo "OK: 内核纯净度检查通过 —— 内核层无 Tauri 运行时直接依赖（仅 $ALLOWED 适配）。"
