-- 0003：Agent 可配置插件（plugins）。
-- 与 skills / mcp / tools 平行的可移植配置维度；存插件标识符 JSON 数组
-- （如 ["feishu", "github"]），语义上对应灵感库中「插件」扩展种类的条目名。
-- 加法迁移（ADR-006）：仅新增列，不改动既有列与数据，旧行默认空数组。
ALTER TABLE agents ADD COLUMN plugins TEXT NOT NULL DEFAULT '[]';
