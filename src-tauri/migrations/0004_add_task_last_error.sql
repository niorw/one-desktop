-- 0004：任务失败原因（last_error）。
-- 供「待决策的任务」卡片展示失败摘要，让群主决策（重试/改派/跳过）前能判断失败原因。
-- 加法迁移（ADR-006）：仅新增列，不改动既有列与数据，旧行默认 NULL。
ALTER TABLE tasks ADD COLUMN last_error TEXT;
