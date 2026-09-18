#!/usr/bin/env bash
# install-hooks.sh — 一键安装 git pre-push 内核纯净度守门员。
#
# 安装的 .git/hooks/pre-push 会在每次 `git push` 前运行 `npm run check:kernel`
# （秒级内核纯净度检查）。违反（内核层直接依赖 Tauri 运行时）则非零退出，
# 挂住推送，防止去 Tauri 化（ADR-001）成果被回潮。
#
# 不跑 cargo test / 全量检查，避免阻塞推送；CI 或本地可另行 `npm run check`。
set -eo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS="$ROOT/.git/hooks"
PRE_PUSH="$HOOKS/pre-push"

if [ -f "$PRE_PUSH" ] && ! grep -q "check:kernel" "$PRE_PUSH" 2>/dev/null; then
  echo "发现已有 pre-push hook，备份为 pre-push.user.bak"
  cp "$PRE_PUSH" "$HOOKS/pre-push.user.bak"
fi

cat > "$PRE_PUSH" <<'EOF'
#!/usr/bin/env bash
# pre-push hook（由 scripts/install-hooks.sh 安装）：推送前守护内核纯净度。
# 仅跑秒级 check:kernel，不跑 cargo test，避免阻塞；违反则非零退出挂住推送。
set -eo pipefail
cd "$(git rev-parse --show-toplevel)"
npm run check:kernel
EOF

chmod +x "$PRE_PUSH"
echo "pre-push hook 已安装：$PRE_PUSH"
echo "后续每次 'git push' 会先运行 'npm run check:kernel'（内核纯净度检查）。"
