# OneDesktop UI 审视报告 · 向 Craft Docs 学习「安静美学」

> 日期：2026-08-05 · UI Designer · 基于 HEAD `3a7033c` · 仅审视、未动代码
> 配套可视化：`docs/design-craft-review-2026-08-05.html`（自示范 Craft 风格活样本）

---

## 0. 用户原话

> "学习 Craft Docs 桌面客户端的设计风格，让后重新审视当前 onedesktop 的 UI 设计。我觉得当前 onedesktop 设计很 low，没有审美，配色老土。"

---

## 1. Craft 的「安静美学」—— 5 大要点

| # | 要点 | 看图怎么对应 |
|---|------|-------------|
| 1 | **中性灰主调**，全屏只有 1 处彩色（右下角 Assistant）| 整屏 #1D1D1F / 灰阶 / 单彩色点睛 |
| 2 | **圆角大**（14-18px），软得像 Mac 原生 | 三张大卡都是大圆角 |
| 3 | **阴影极轻**，几乎无投影 | 卡片靠"浅暖灰 canvas + 纯白卡片"对比浮出 |
| 4 | **11-13-15-17 字号**克制 | 不靠"花"字号撑场面 |
| 5 | **线性单色图标 1.5px stroke** | 全图统一样式 |

---

## 2. OneDesktop 现状摸底（基于 8/4 HEAD 代码）

| 维度 | 当前值（App.css） | 审视 |
|------|-------------------|------|
| 背景 | `--bg-primary: #ffffff`（整屏纯白）| 没有"底"和"片"之分 → 卡片浮不起来 |
| 侧栏 | `--bg-secondary: #f5f5f7` | 够了，能用 |
| 主色 | `--accent: #006edb` | 饱和度偏高、面积用得猛 |
| **Logo** | `linear-gradient(--accent → --accent-pressed)` + `box-shadow: var(--shadow-sm)` + `border-radius: 6` | 像 2018 SaaS 营销页 logo，**low 的第一感** |
| 卡片圆角 | `--radius-md: 10` / `--radius-lg: 14` | 偏硬，缺"软" |
| 卡片阴影 | `--shadow-md: 0 4px 12px rgba(0,0,0,.08)` | **low 的第二感**——所有"浮起来"的地方都偏重 |
| User 气泡 | `background: var(--accent)` 全蓝填充 | 整屏蓝气泡跳，太花哨 |
| 侧栏选中态 | `--accent-soft` 蓝色 8% 软底 | 比纯灰底差口气 |

---

## 3. 7 个具体差距（按"最显眼"排序）

1. **Logo 渐变 + 阴影** → 改纯色块 + 移除 box-shadow + 圆角 6→4
2. **卡片阴影偏重** → 改 `--shadow-card: 0 1px 2px rgba(0,0,0,.04)` 唯一一档
3. **卡片圆角偏小** → 新增 `--radius-card: 16px`（替代 14）
4. **背景几乎纯白** → 新增 `--bg-canvas: #FAFAFC`，内容区用 canvas，卡片 surface
5. **User 气泡全蓝饱和** → 改成 hybrid：浅灰底 + 蓝色左边条
6. **选中态偏蓝** → 改纯灰底（`#EBEBF0`），让文字深承担"选中"语义
7. **顶栏左偏空** → 重排：左 drag region + 中标题 + 右上 4 图标

---

## 4. 升级原则（守住 8 条底线）

1. **色彩**：中性灰主调，主色 ≤5% 面积
2. **背景层**：canvas 和 surface 必须有灰度差
3. **字号**：10/11/12/13/15/17/20/24px type scale
4. **圆角**：8-10 / 10 / 14 / 16-18 四档
5. **阴影**：极轻一档 `0 1px 2px rgba(0,0,0,.04)`，不再分 sm/md/lg
6. **图标**：单色 SVG，`stroke="currentColor"`，禁止 emoji
7. **间距**：8px 网格，gap ≥ 16px
8. **动效**：200ms cubic-bezier，仅颜色过渡

---

## 5. V1 ~ V4 方案

| 方案 | 工作量 | 改动 | 风险 | 何时选 |
|------|--------|------|------|--------|
| **V1 小修** | 1-2 小时 | Logo / 阴影 / 选中态 三处 | 极低 | 先做"心理锚点"，快速立竿见影 |
| **V2 中修** ★推荐起点 | 1 天 | V1 + canvas 背景 + 卡片圆角 16 + User 气泡 + TopBar 重排 + 主标题字重 | 中 | 整屏换光、性价比最高 |
| **V3 大改** | 2-3 PR | 所有 token 全调 + 图标库收敛 + 启动屏换肤 | 整窗一次变 | 想"全方位 Craft 化"时 |
| **V4 渐进** ★推荐路径 | 3 次小迭代 | 第 1 步 V1 → 第 2 步 V2 → 第 3 步按需 V3 | 最低 | **每一步可回退、可对照、可让团队对齐** |

---

## 6. 推荐节奏（V4）

- **Day 0**：V1（logo + 阴影 + 选中态）。一个 PR，commit: `chore(ui): apply craft-style bare minimum`。
- **Day 1**：V2（canvas 背景 + 大卡片圆角 + TopBar 重排 + User 气泡 hybrid）。只动 token + 视觉骨架，不碰业务。
- **Day 2+**：看反馈决定要不要做 V3 收尾。**不一次性大改**。

---

## 7. Token 改动清单（V1+V2 落地，11 条）

| Token | 当前 | 改成 | 用途 |
|-------|------|------|------|
| `--bg-canvas` | 无 | `#FAFAFC` 新增 | 内容区背景 |
| `--shadow-card` | 复用 `--shadow-md` | `0 1px 2px rgba(0,0,0,.04)` 新增 | 统一大卡片 |
| `--radius-card` | 无 | `16px` 新增 | 群 / 任务 / 详情卡片 |
| `--radius-md` | `10px` | 保留 | 按钮 / 输入框 |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,.08)` | `0 2px 6px rgba(0,0,0,.04)` | 中卡片 / 抽屉 |
| `.sidebar-nav-item.active` | `background: --accent-soft` | `background: #EBEBF0` | 侧栏选中态 |
| `.sidebar-group-item.active` | 同 | 同 | 群项选中态 |
| `.message-bubble.user` | `background: --accent` | `background: --bg-elevated` + 蓝边 | User 气泡 hybrid |
| `.topbar-title` | font-weight 600 | 保持 600 + letter-spacing -0.02em | 标题克制 |
| `Sidebar.tsx LogoMark` | gradient + box-shadow | `fill: #0066CC` + 移除 box-shadow | logo 去装饰 |
| `TopBar.tsx` 右侧 | 留白 | 4 图标（视图 / 排序 / 搜索 / 设置）| 顶栏紧凑 |

---

## 8. 需要用户拍板的两件事

1. **升级路径**：V1 / V2 / V3 / V4 → 推荐 **V4**（先 V1 再 V2 按需 V3）
2. **配色策略**：
   - **A. 保留主蓝做"极少强调"**：user 气泡蓝边 / 主色仅出现在按钮 + 选中；其它全灰
   - **B. 全砍掉纯中性**：主色彻底退场，所有地方都灰，做成"无品牌"产品（更 Mac）

---

## 9. 风险与不在本期范围

- **不在本期**：抽屉 / 弹窗重设计、图标库收敛到 1.5px set、深色模式重调
- **会被影响**：当前 4 张 chromium 视觉快照（V2 后需要 `--update-snapshots` 刷新）
- **不会影响**：E2E 选择器（不动 class 名）、i18n 文案（不动 key）
