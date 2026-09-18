-- ═══════════════════════════════════════════════════════════════════
-- OneDesktop 群测试数据（场景覆盖全）— 纯 SQL 版
--
-- 覆盖矩阵：
--   GroupStatus   : Draft / Active / Paused / Archiving / Archived
--   SeatType      : Static / Capability
--   WorkerStatus  : Idle / Busy / Offline
--   TaskStatus    : Pending / InProgress / Completed / Failed / Cancelled
--   run kind      : chat / worker / roundtable / scheduled
--   run status    : ok / failed / running / timeout / cancelled
--   run_steps     : llm / tool / approval 三种步骤
--   圆桌消息      : owner 广播 / worker 回复 / mentions
--   圆桌摘要      : 2 条（含 source 区间）
--   R6 竞速备选   : 2 条落选方案
--   worker_metrics: 3 条聚合
--   R7 升级群     : 1 个 session.mode=group 关联（含 3 条升级前历史）
--   deliverables  : reply / task_output / summary 三类聚合源齐备
--
-- 用法：
--   sqlite3 ~/.one-desktop/db/onedesktop.db < scripts/seed_groups_demo.sql
--   （建议先 cp 备份原库）
--
-- 幂等：对测试群数据先 DELETE 再 INSERT，可安全重复执行；不动既有真实数据。
-- 时间戳约定（与 Rust 端一致）：
--   groups.created_at                 = 秒（Utc::now().timestamp()）
--   roundtable_*/worker_metrics/runs  = 毫秒
--   sessions/messages.created_at      = ISO 字符串
-- 枚举/集合字段为 JSON 字符串（serde_json::to_string）："Active"、["write"]
-- ═══════════════════════════════════════════════════════════════════

-- 时间基准（基于 SQLite now，避免硬编码）
--   TS_SEC  = 当前秒；TS_MS = 当前毫秒；D/H/M = 天/时/分（秒）
SELECT 1; -- 占位（以下用表达式内联）

-- ── 0) 清理测试群旧数据（幂等） ─────────────────────────────────────
DELETE FROM run_steps    WHERE run_id IN (SELECT id FROM runs WHERE group_id IN ('grp_alpha','grp_beta','grp_gamma','grp_delta','grp_epsilon','grp_zeta'));
DELETE FROM runs         WHERE group_id IN ('grp_alpha','grp_beta','grp_gamma','grp_delta','grp_epsilon','grp_zeta');
DELETE FROM roundtable_alternatives WHERE group_id IN ('grp_alpha','grp_beta','grp_gamma','grp_delta','grp_epsilon','grp_zeta');
DELETE FROM roundtable_summaries    WHERE group_id IN ('grp_alpha','grp_beta','grp_gamma','grp_delta','grp_epsilon','grp_zeta');
DELETE FROM roundtable_messages     WHERE group_id IN ('grp_alpha','grp_beta','grp_gamma','grp_delta','grp_epsilon','grp_zeta');
DELETE FROM worker_metrics          WHERE group_id IN ('grp_alpha','grp_beta','grp_gamma','grp_delta','grp_epsilon','grp_zeta');
DELETE FROM tasks                   WHERE group_id IN ('grp_alpha','grp_beta','grp_gamma','grp_delta','grp_epsilon','grp_zeta');
DELETE FROM workers                 WHERE group_id IN ('grp_alpha','grp_beta','grp_gamma','grp_delta','grp_epsilon','grp_zeta');
DELETE FROM groups                  WHERE id IN ('grp_alpha','grp_beta','grp_gamma','grp_delta','grp_epsilon','grp_zeta');
DELETE FROM messages                WHERE session_id = 's_upgrade_alpha';
DELETE FROM sessions                WHERE id = 's_upgrade_alpha';

-- ── 1) Agent 预设（4 个；INSERT OR REPLACE 幂等） ──────────────────
-- capabilities 为 UI 展示元数据（工具准入由 ToolScope 白名单 + 权限矩阵决定，
-- get_weather 已加入 WORKER_DEFAULT_ALLOWED，所有 Worker 均可调用）。
INSERT OR REPLACE INTO agents (id,name,model,system_prompt,capabilities,skills,mcp,tools,created_at,token_budget,provider,executor) VALUES
  ('p_researcher','Researcher','deepseek-chat','研究型 agent：检索、汇总、比较','["search","summarize","weather"]','[]','[]','[]',CAST(strftime('%s','now') AS INTEGER)-30*86400,100000,'deepseek',NULL),
  ('p_writer','Writer','deepseek-chat','写作型 agent：报告、文案、润色','["write"]','[]','[]','[]',CAST(strftime('%s','now') AS INTEGER)-30*86400,100000,'deepseek',NULL),
  ('p_coder','Coder','deepseek-chat','编码型 agent：实现、重构、审查','["code"]','[]','[]','[]',CAST(strftime('%s','now') AS INTEGER)-30*86400,100000,'deepseek',NULL),
  ('p_analyst','Analyst','deepseek-chat','分析型 agent：数据、定价、趋势','["analyze","research","weather"]','[]','[]','[]',CAST(strftime('%s','now') AS INTEGER)-30*86400,100000,'deepseek',NULL);

-- ── 2) 群（6 个，覆盖全部状态） ─────────────────────────────────────
INSERT OR REPLACE INTO groups (id,name,goal,owner_agent_ref,status,seat_config,created_at) VALUES
  ('grp_alpha','竞品分析群','对三款竞品做功能与定价对比，输出选型建议','p_researcher','"Active"','{"seats":[{"agent_ref":"p_writer","seat_type":"Static"},{"agent_ref":"p_coder","seat_type":"Static"}]}',CAST(strftime('%s','now') AS INTEGER)-3*86400),
  ('grp_beta','新品发布策划','为新品策划上市方案：定位、渠道、节奏','p_writer','"Active"','{"seats":[{"agent_ref":"p_analyst","seat_type":"Static"},{"agent_ref":"p_researcher","seat_type":"Static"}]}',CAST(strftime('%s','now') AS INTEGER)-2*86400-5*3600),
  ('grp_gamma','代码审查小组','对核心模块做一轮系统代码审查','p_coder','"Paused"','{"seats":[{"agent_ref":"p_coder","seat_type":"Static"}]}',CAST(strftime('%s','now') AS INTEGER)-2*86400),
  ('grp_delta','技术选型调研','评估 3 套方案的技术栈与迁移成本','p_researcher','"Draft"','{}',CAST(strftime('%s','now') AS INTEGER)-86400),
  ('grp_epsilon','发布复盘归档','复盘上季度发布过程，沉淀经验','p_analyst','"Archived"','{"seats":[{"agent_ref":"p_writer","seat_type":"Static"}]}',CAST(strftime('%s','now') AS INTEGER)-10*86400),
  ('grp_zeta','知识库整理','把散落文档整理成结构化知识库','p_writer','"Archiving"','{"seats":[{"agent_ref":"p_researcher","seat_type":"Static"},{"agent_ref":"p_analyst","seat_type":"Static"}]}',CAST(strftime('%s','now') AS INTEGER)-5*3600);

-- ── 3) 席位（8 个：Static + Capability；Idle/Busy/Offline） ────────
INSERT OR REPLACE INTO workers (id,group_id,agent_ref,seat_type,status,max_concurrency,capabilities,current_task_id,last_heartbeat) VALUES
  ('wk_alpha_writer','grp_alpha','p_writer','"Static"','"Idle"',1,'["write"]',NULL,CAST(strftime('%s','now') AS INTEGER)*1000-3*60000),
  ('wk_alpha_coder','grp_alpha','p_coder','"Static"','"Busy"',2,'["code"]','t_alpha_3',CAST(strftime('%s','now') AS INTEGER)*1000-60000),
  ('wk_alpha_cap','grp_alpha','','"Capability"','"Offline"',1,'["search","summarize"]',NULL,CAST(strftime('%s','now') AS INTEGER)*1000-2*3600000),
  ('wk_beta_analyst','grp_beta','p_analyst','"Static"','"Idle"',1,'["analyze","research"]',NULL,CAST(strftime('%s','now') AS INTEGER)*1000-4*60000),
  ('wk_beta_researcher','grp_beta','p_researcher','"Static"','"Idle"',1,'["search","summarize"]',NULL,CAST(strftime('%s','now') AS INTEGER)*1000-4*60000),
  ('wk_gamma_coder','grp_gamma','p_coder','"Static"','"Idle"',1,'["code"]',NULL,CAST(strftime('%s','now') AS INTEGER)*1000-30*60000),
  ('wk_epsilon_writer','grp_epsilon','p_writer','"Static"','"Offline"',1,'["write"]',NULL,CAST(strftime('%s','now') AS INTEGER)*1000-8*86400000),
  ('wk_zeta_analyst','grp_zeta','p_analyst','"Static"','"Busy"',1,'["analyze"]','t_zeta_1',CAST(strftime('%s','now') AS INTEGER)*1000-30000);

-- ── 4) 任务（覆盖 5 态 + 依赖 + outputs） ──────────────────────────
INSERT OR REPLACE INTO tasks (id,group_id,batch_id,worker_id,description,depends_on,input_refs,output_spec,status,retry_count,assigned_worker,outputs,reasoning,capability) VALUES
  ('t_alpha_1','grp_alpha','batch_alpha_1','wk_alpha_writer','梳理竞品 A/B/C 的功能清单','[]','["调研需求"]','功能对比表','"Completed"',0,'wk_alpha_writer','["A：实时协作/B：离线优先/C：开源自托管"]','先盘点公开功能，再逐项对比',NULL),
  ('t_alpha_2','grp_alpha','batch_alpha_1','wk_alpha_writer','整理三款竞品的定价模型','["t_alpha_1"]','[]','定价汇总','"Completed"',0,'wk_alpha_writer','["A：按席位订阅；B：一次性买断；C：社区版免费+企业版"]','定价影响选型，需精确',NULL),
  ('t_alpha_3','grp_alpha','batch_alpha_1','wk_alpha_coder','抓取竞品官网公开页面数据','["t_alpha_2"]','[]','结构化数据','"InProgress"',0,'wk_alpha_coder','[]','官网公开数据，注意频率限制',NULL),
  ('t_alpha_4','grp_alpha','batch_alpha_2','wk_alpha_cap','对候选方案做成本建模','[]','["t_alpha_2"]','成本模型','"Pending"',0,NULL,'[]',NULL,'analyze'),
  ('t_alpha_5','grp_alpha','batch_alpha_2',NULL,'输出选型建议报告','["t_alpha_3","t_alpha_4"]','[]','报告','"Pending"',0,NULL,'[]',NULL,'write'),
  ('t_beta_1','grp_beta','batch_beta_1','wk_beta_analyst','市场定位与目标人群分析','[]','[]','定位文档','"Completed"',0,'wk_beta_analyst','["核心人群：中小团队管理者"]',NULL,NULL),
  ('t_beta_2','grp_beta','batch_beta_1','wk_beta_researcher','渠道策略调研','[]','[]','渠道清单','"Failed"',2,'wk_beta_researcher','[]','渠道数据缺失，重试后失败',NULL),
  ('t_beta_3','grp_beta','batch_beta_1','wk_beta_analyst','上市节奏规划','["t_beta_1"]','[]','时间表','"Cancelled"',0,'wk_beta_analyst','[]','需求变更取消',NULL),
  ('t_gamma_1','grp_gamma','batch_gamma_1','wk_gamma_coder','审查核心模块错误处理','[]','[]','审查报告','"Pending"',0,NULL,'[]',NULL,NULL),
  ('t_gamma_2','grp_gamma','batch_gamma_1','wk_gamma_coder','审查数据层事务边界','["t_gamma_1"]','[]','审查报告','"Pending"',0,NULL,'[]',NULL,NULL),
  ('t_epsilon_1','grp_epsilon','batch_epsilon_1','wk_epsilon_writer','撰写发布复盘文档','[]','[]','复盘文档','"Completed"',0,'wk_epsilon_writer','["延期原因：第三方依赖阻塞；改进：预留缓冲期"]',NULL,NULL),
  ('t_epsilon_2','grp_epsilon','batch_epsilon_1','wk_epsilon_writer','提炼经验清单','["t_epsilon_1"]','[]','清单','"Completed"',0,'wk_epsilon_writer','["1. 依赖锁版本 2. 验收前置 3. 复盘会固定议程"]',NULL,NULL),
  ('t_zeta_1','grp_zeta','batch_zeta_1','wk_zeta_analyst','文档分类与打标签','[]','[]','分类索引','"InProgress"',0,'wk_zeta_analyst','[]',NULL,NULL);

-- ── 5) 圆桌消息（owner 广播 + worker 回复 + mentions） ─────────────
INSERT INTO roundtable_messages (group_id, author, worker_id, author_kind, content, mentions, attachments, created_at) VALUES
  ('grp_alpha','p_researcher','','owner','我们先梳理竞品清单，再进入对比。请 writer 与 coder 各司其职。','["wk_alpha_writer","wk_alpha_coder"]','[]',CAST(strftime('%s','now') AS INTEGER)*1000-3*86400000),
  ('grp_alpha','wk_alpha_writer','wk_alpha_writer','worker','A 产品的功能清单已整理：实时协作、评论、历史版本。','[]','[]',CAST(strftime('%s','now') AS INTEGER)*1000-3*86400000+30*60000),
  ('grp_alpha','wk_alpha_coder','wk_alpha_coder','worker','官网公开页面可抓取，我会控制频率避免封禁。','[]','[]',CAST(strftime('%s','now') AS INTEGER)*1000-3*86400000+50*60000),
  ('grp_alpha','p_researcher','','owner','收到，定价信息是选型关键，writer 补充一下。','["wk_alpha_writer"]','[]',CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000),
  ('grp_alpha','wk_alpha_writer','wk_alpha_writer','worker','定价汇总完成：A 订阅制、B 买断制、C 社区版免费。','[]','[]',CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+20*60000),
  ('grp_alpha','p_researcher','','owner','很好。coder 抓取完数据后，我们进入成本建模。','["wk_alpha_coder"]','[]',CAST(strftime('%s','now') AS INTEGER)*1000-86400000),
  ('grp_alpha','wk_alpha_coder','wk_alpha_coder','worker','数据抓取中，完成 60%，预计 2 小时后交付结构化数据。','[]','[]',CAST(strftime('%s','now') AS INTEGER)*1000-86400000+15*60000),
  ('grp_beta','p_writer','','owner','新品策划启动：先定人群，再定渠道与节奏。','["wk_beta_analyst","wk_beta_researcher"]','[]',CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000-4*3600000),
  ('grp_beta','wk_beta_analyst','wk_beta_analyst','worker','人群定位完成：中小团队管理者，强调轻量上手。','[]','[]',CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000-3*3600000),
  ('grp_beta','wk_beta_researcher','wk_beta_researcher','worker','渠道调研遇到数据缺失，部分渠道信息不完整。','[]','[]',CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000-2*3600000),
  ('grp_zeta','p_writer','','owner','开始整理知识库，先分类打标签。','["wk_zeta_analyst"]','[]',CAST(strftime('%s','now') AS INTEGER)*1000-4*3600000),
  ('grp_zeta','wk_zeta_analyst','wk_zeta_analyst','worker','已扫描 200 份文档，正在分类。','[]','[]',CAST(strftime('%s','now') AS INTEGER)*1000-3*3600000);

-- ── 6) 圆桌摘要（2 条；source 区间取自 grp_alpha 实际 seq） ────────
INSERT INTO roundtable_summaries (group_id, content, source_seq_start, source_seq_end, message_count, created_at)
SELECT 'grp_alpha', '竞品功能对比完成：A 功能最全但最贵，B 买断制适合中小团队，C 开源社区活跃。',
       (SELECT MIN(seq) FROM roundtable_messages WHERE group_id='grp_alpha'),
       (SELECT MIN(seq)+2 FROM roundtable_messages WHERE group_id='grp_alpha'), 3,
       CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+10*60000;

INSERT INTO roundtable_summaries (group_id, content, source_seq_start, source_seq_end, message_count, created_at)
SELECT 'grp_alpha', '定价模型已明确，下一步进入成本建模与选型建议。',
       (SELECT MIN(seq)+3 FROM roundtable_messages WHERE group_id='grp_alpha'),
       (SELECT MAX(seq) FROM roundtable_messages WHERE group_id='grp_alpha'),
       (SELECT COUNT(*) FROM roundtable_messages WHERE group_id='grp_alpha')-3,
       CAST(strftime('%s','now') AS INTEGER)*1000-3600000;

-- ── 7) R6 竞速备选（2 条；trigger_seq 取 grp_alpha 最新 owner 广播） ─
INSERT INTO roundtable_alternatives (group_id, trigger_seq, worker_id, content, created_at)
SELECT 'grp_alpha', seq, 'wk_alpha_writer', '备选：建议先用问卷调查补充用户侧定价敏感度。', CAST(strftime('%s','now') AS INTEGER)*1000-30*60000
FROM roundtable_messages WHERE group_id='grp_alpha' AND author_kind='owner' ORDER BY seq DESC LIMIT 1;

INSERT INTO roundtable_alternatives (group_id, trigger_seq, worker_id, content, created_at)
SELECT 'grp_alpha', seq, 'wk_alpha_cap', '备选：对比开源替代方案的成本曲线。', CAST(strftime('%s','now') AS INTEGER)*1000-25*60000
FROM roundtable_messages WHERE group_id='grp_alpha' AND author_kind='owner' ORDER BY seq DESC LIMIT 1;

-- ── 8) worker_metrics（3 条聚合） ──────────────────────────────────
INSERT OR REPLACE INTO worker_metrics (worker_id,group_id,total_tokens,total_duration_ms,runs,last_msg_count,last_context_tokens,last_total_tokens,updated_at,trace_id) VALUES
  ('wk_alpha_writer','grp_alpha',124500,3600000,14,8,12000,15300,CAST(strftime('%s','now') AS INTEGER)*1000-2*60000,'trace_alpha_w'),
  ('wk_alpha_coder','grp_alpha',98700,2900000,11,6,9800,12100,CAST(strftime('%s','now') AS INTEGER)*1000-60000,'trace_alpha_c'),
  ('wk_beta_analyst','grp_beta',45200,1300000,6,5,7600,9200,CAST(strftime('%s','now') AS INTEGER)*1000-3*60000,'trace_beta_a');

-- ── 9) runs + run_steps（覆盖 kind/status/step 全类型） ────────────
INSERT OR REPLACE INTO runs (id,session_id,group_id,seat_id,kind,started_at,ended_at,status,model,prompt_tokens,output_tokens,iterations,error_kind) VALUES
  ('run_alpha_1','s_upgrade_alpha','grp_alpha','wk_alpha_writer','worker',CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+45000,'ok','deepseek-chat',1200,340,3,NULL),
  ('run_alpha_2','s_upgrade_alpha','grp_alpha','wk_alpha_coder','worker',CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+3600000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+3600000+90000,'failed','deepseek-chat',2100,480,5,'http_429'),
  ('run_alpha_3','s_upgrade_alpha','grp_alpha','wk_alpha_coder','worker',CAST(strftime('%s','now') AS INTEGER)*1000-86400000,NULL,'running','deepseek-chat',900,0,2,NULL),
  ('run_alpha_4','s_upgrade_alpha','grp_alpha',NULL,'roundtable',CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+7200000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+7200000+12000,'ok','deepseek-chat',4500,890,1,NULL),
  ('run_alpha_5','s_upgrade_alpha','grp_alpha','wk_alpha_writer','scheduled',CAST(strftime('%s','now') AS INTEGER)*1000-86400000-3*3600000,CAST(strftime('%s','now') AS INTEGER)*1000-86400000-3*3600000+5000,'cancelled','deepseek-chat',300,0,1,'user_cancelled'),
  ('run_alpha_6','s_upgrade_alpha','grp_alpha','wk_alpha_cap','worker',CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+3*3600000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+3*3600000+120000,'timeout','deepseek-chat',5000,1200,8,'step_timeout'),
  ('run_beta_1','s_upgrade_alpha','grp_beta','wk_beta_analyst','worker',CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000-2*3600000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000-2*3600000+30000,'ok','deepseek-chat',800,210,2,NULL),
  ('run_beta_2','s_upgrade_alpha','grp_beta','wk_beta_researcher','worker',CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000-3600000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000-3600000+70000,'failed','deepseek-chat',1600,320,4,'tool_unavailable'),
  ('run_zeta_1','s_upgrade_alpha','grp_zeta','wk_zeta_analyst','worker',CAST(strftime('%s','now') AS INTEGER)*1000-3*3600000,NULL,'running','deepseek-chat',700,0,1,NULL);

INSERT INTO run_steps (run_id,seq,kind,name,origin,args_digest,outcome,unavailable_reason,approval_source,approval_decision,duration_ms,started_at) VALUES
  ('run_alpha_1',1,'llm','整理功能清单','worker',NULL,'ok',NULL,NULL,NULL,8000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000),
  ('run_alpha_1',2,'tool','web_search','worker',NULL,'ok',NULL,NULL,NULL,30000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+8000),
  ('run_alpha_1',3,'llm','汇总对比','worker',NULL,'ok',NULL,NULL,NULL,7000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+38000),
  ('run_alpha_2',1,'llm','抓取网页','worker',NULL,'ok',NULL,NULL,NULL,10000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+3600000),
  ('run_alpha_2',2,'tool','http_fetch','worker',NULL,'failed',NULL,NULL,NULL,80000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+3600000+10000),
  ('run_alpha_3',1,'llm','继续抓取','worker',NULL,'ok',NULL,NULL,NULL,5000,CAST(strftime('%s','now') AS INTEGER)*1000-86400000),
  ('run_alpha_3',2,'tool','http_fetch','worker',NULL,'ok',NULL,NULL,NULL,20000,CAST(strftime('%s','now') AS INTEGER)*1000-86400000+5000),
  ('run_alpha_3',3,'llm','解析数据','worker',NULL,'ok',NULL,NULL,NULL,6000,CAST(strftime('%s','now') AS INTEGER)*1000-86400000+25000),
  ('run_alpha_4',1,'llm','聚合圆桌','roundtable',NULL,'ok',NULL,NULL,NULL,12000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+7200000),
  ('run_alpha_5',1,'llm','定时摘要','scheduled',NULL,'unavailable',NULL,NULL,NULL,5000,CAST(strftime('%s','now') AS INTEGER)*1000-86400000-3*3600000),
  ('run_alpha_6',1,'llm','成本建模','worker',NULL,'ok',NULL,NULL,NULL,6000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+3*3600000),
  ('run_alpha_6',2,'approval','审批：执行 python 脚本','worker',NULL,'failed',NULL,NULL,NULL,100000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+3*3600000+6000),
  ('run_alpha_6',3,'tool','python_exec','worker',NULL,'unavailable',NULL,NULL,NULL,5000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000+3*3600000+106000),
  ('run_beta_1',1,'llm','人群分析','worker',NULL,'ok',NULL,NULL,NULL,9000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000-2*3600000),
  ('run_beta_1',2,'tool','data_query','worker',NULL,'ok',NULL,NULL,NULL,18000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000-2*3600000+9000),
  ('run_beta_2',1,'llm','渠道调研','worker',NULL,'ok',NULL,NULL,NULL,8000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000-3600000),
  ('run_beta_2',2,'tool','web_search','worker',NULL,'failed',NULL,NULL,NULL,60000,CAST(strftime('%s','now') AS INTEGER)*1000-2*86400000-3600000+8000),
  ('run_zeta_1',1,'llm','文档分类','worker',NULL,'ok',NULL,NULL,NULL,7000,CAST(strftime('%s','now') AS INTEGER)*1000-3*3600000),
  ('run_zeta_1',2,'tool','file_scan','worker',NULL,'ok',NULL,NULL,NULL,15000,CAST(strftime('%s','now') AS INTEGER)*1000-3*3600000+7000);

-- ── 10) R7 升级群场景：grp_alpha 关联 mode=group 会话 ──────────────
INSERT INTO sessions (id,title,model,preamble,created_at,updated_at,mode,group_id) VALUES
  ('s_upgrade_alpha','竞品分析（升级前对话）','deepseek-chat','',
   strftime('%Y-%m-%dT%H:%M:%f+00:00','now','-3 days'),
   strftime('%Y-%m-%dT%H:%M:%f+00:00','now','-3 days'),
   'group','grp_alpha');

INSERT INTO messages (session_id, role, content, tool_name, tool_args, tool_result, token_usage, reasoning_content, created_at) VALUES
  ('s_upgrade_alpha','user','帮我分析下竞品 A 的功能和定价，我准备选型。',NULL,NULL,NULL,0,'',strftime('%Y-%m-%dT%H:%M:%f+00:00','now','-3 days')),
  ('s_upgrade_alpha','assistant','好的，我可以拆一个协作群：研究员负责功能对比、写作席输出建议。',NULL,NULL,NULL,0,'',strftime('%Y-%m-%dT%H:%M:%f+00:00','now','-3 days','+30 seconds')),
  ('s_upgrade_alpha','user','可以，开始吧。',NULL,NULL,NULL,0,'',strftime('%Y-%m-%dT%H:%M:%f+00:00','now','-3 days','+60 seconds'));

-- ═══════════════════════════════════════════════════════════════════
-- 完成。验证：
--   SELECT status, COUNT(*) FROM groups GROUP BY status;
--   PRAGMA foreign_key_check;
-- ═══════════════════════════════════════════════════════════════════
