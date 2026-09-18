#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为 OneDesktop 注入多场景圆桌（roundtable）演示数据。

特点：
- 自洽：配套创建 Agent 画像(agents) + 群(groups) + 席位(workers) + 圆桌消息 + 结构化摘要。
- 幂等：运行前先清除上一轮的 demo_* 数据，可反复执行。
- 序列化形态与 Rust 端一致：枚举存带引号 JSON（"Active"），数组存 JSON 数组串。

仅用于本地开发 / 测试，不影响生产数据（会先备份原库）。
"""

import datetime
import json
import os
import shutil
import sqlite3
import time

DB = os.path.expanduser("~/.one-desktop/db/onedesktop.db")
assert os.path.exists(DB), f"找不到数据库: {DB}"


def j(v):
    """序列化成与 Rust serde_json 一致的紧凑 JSON（无空格）。"""
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


now = int(time.time() * 1000)
H = 3600 * 1000
M = 60 * 1000

# ── Agent 画像：4 个群主 + 10 个可跨群复用的 Worker 池 ──
AGENTS = [
    # owners
    ("demo_owner_compete", "战略分析师·澜", "deepseek-chat",
     "你是一位资深战略与竞争情报分析师，善于拆解竞品、识别差异化机会并给出可执行建议。",
     ["strategy", "competitive", "intelligence"]),
    ("demo_owner_tech", "技术负责人·衡", "deepseek-chat",
     "你是研发团队的技术负责人，主导重大技术选型与架构评审，重视演进式与交付成本。",
     ["architecture", "tech-lead", "review"]),
    ("demo_owner_growth", "增长负责人·野", "deepseek-chat",
     "你是增长团队负责人，关注获客、留存与 ROI，擅长渠道组合与预算分配。",
     ["growth", "strategy", "analytics"]),
    ("demo_owner_pr", "公关总监·澄", "deepseek-chat",
     "你是公关与品牌危机负责人，擅长在舆情中快速拉齐口径、平衡事实与声誉。",
     ["pr", "crisis", "communication"]),
    # worker pool
    ("demo_ag_research", "行业研究员·砚", "deepseek-chat",
     "你专注竞品与行业研究，能快速拆解功能、识别护城河与可复制性。",
     ["web", "research", "competitive"]),
    ("demo_ag_data", "数据分析师·枢", "deepseek-chat",
     "你擅长从社媒、商店与行为数据中提取信号，用指标支撑决策。",
     ["sql", "analysis", "visualization"]),
    ("demo_ag_writer", "内容撰写员·墨", "deepseek-chat",
     "你擅长把结论写成清晰、有说服力的方案与长文，注重差异化话术。",
     ["writing", "editing", "summary"]),
    ("demo_ag_backend", "后端工程师·砺", "deepseek-chat",
     "你专注服务端工程，关注性能、边界与可演进的模块设计。",
     ["rust", "api", "database"]),
    ("demo_ag_frontend", "前端工程师·澈", "deepseek-chat",
     "你关注接口契约、一致性与前端交付体验。",
     ["react", "typescript", "css"]),
    ("demo_ag_architect", "系统架构师·峤", "deepseek-chat",
     "你擅长分布式系统与演进式架构，权衡扩展性与团队成本。",
     ["architecture", "distributed", "scaling"]),
    ("demo_ag_growth", "增长策略师·飒", "deepseek-chat",
     "你擅长渠道打法与增长实验，强调 ROI 与机动预算。",
     ["growth", "ads", "retention"]),
    ("demo_ag_media", "媒体关系·岚", "deepseek-chat",
     "你负责媒体与对外沟通，擅长口径管理与舆情监测。",
     ["media", "pr", "communication"]),
    ("demo_ag_legal", "法务顾问·正", "deepseek-chat",
     "你把控法律与合规底线，以事实与条款为准绳。",
     ["legal", "compliance", "risk"]),
    ("demo_ag_social", "社媒运营·溪", "deepseek-chat",
     "你负责社交媒体运营，擅长控评、FAQ 与社区沟通。",
     ["social", "content", "community"]),
]
CAPS = {a[0]: a[4] for a in AGENTS}
AGENT_ROWS = [(a[0], a[1], a[2], a[3], j(a[4]), j([]), j([]), j([]), now) for a in AGENTS]

# ── 四个场景 ──
SCENARIOS = [
    {
        "gid": "demo_g_compete",
        "name": "竞品分析作战室",
        "goal": "监控并拆解头部竞品动向，输出可执行的差异化跟进策略。",
        "owner": "demo_owner_compete",
        "base": now - 3 * H,
        "workers": [
            ("demo_w_compete_1", "demo_ag_research", "Idle"),
            ("demo_w_compete_2", "demo_ag_data", "Busy"),
            ("demo_w_compete_3", "demo_ag_writer", "Idle"),
        ],
        "messages": [
            {"author": "demo_owner_compete", "kind": "owner",
             "mentions": ["demo_w_compete_1", "demo_w_compete_2"],
             "text": "竞品 Nova 上周上线了 AI 摘要功能，主打「零配置接入」。@研究员 @数据分析师 请分别从功能拆解与用户反馈两个角度先给情报，我们再决定要不要跟。"},
            {"author": "demo_ag_research", "kind": "worker", "mentions": [],
             "text": "拆了一遍：Nova 的 AI 摘要本质是套了现成大模型的模板抽取，支持 12 种文档格式，但长文档会丢上下文。卖点是「上传即用」，实测首次配置仍需选模型。护城河不深，技术可复制。"},
            {"author": "demo_ag_data", "kind": "worker", "mentions": [],
             "text": "拉了 7 天社媒与商店评论：好评集中在「省时间」(62%)，差评集中在「中文摘要质量差」(28%) 和「偶发超时」(10%)。月活环比 +18%，但留存第 7 日仅 31%，说明尝鲜多、沉淀少。"},
            {"author": "demo_owner_compete", "kind": "owner", "mentions": [],
             "text": "结论方向清晰了：跟，但不在「零配置」上卷，而是打「中文长文档质量」这个他们最弱的缺口。@内容撰写员 据此起草一页跟进方案，重点写差异化话术。"},
            {"author": "demo_ag_writer", "kind": "worker", "mentions": [],
             "text": "方案一页已起草：核心主张「中文长文不丢上下文」，三栏对比（格式/长度/语种），结尾埋试用 CTA。需要产品侧确认是否开放 50 页以上文档的白名单。"},
            {"author": "demo_owner_compete", "kind": "owner", "mentions": [],
             "text": "白名单我先开内部灰度，对外先讲价值再谈限制。今天就按这个方向推。"},
        ],
        "summary": "【核心结论】竞品 Nova 的 AI 摘要功能护城河不深，其最大弱点是中文长文档摘要质量差；我方应避开「零配置」同质化竞争，主打「中文长文不丢上下文」的差异化卖点。\n【各方观点】研究员指出 Nova 技术上可复制、首次配置仍需选模型；数据分析师补充其留存偏低（7 日 31%）、差评集中于中文质量与超时；内容撰写员据此产出一页对比方案。\n【分歧与共识】初期对「是否跟进」有犹豫，最终达成共识：跟，但走差异化而非同质化。\n【悬而未决】50 页以上文档白名单对外口径尚未定，暂以内部灰度过渡。",
    },
    {
        "gid": "demo_g_tech",
        "name": "架构评审委员会",
        "goal": "对重大技术选型与重构方案进行多方评审并达成共识。",
        "owner": "demo_owner_tech",
        "base": now - 2 * H,
        "workers": [
            ("demo_w_tech_1", "demo_ag_backend", "Busy"),
            ("demo_w_tech_2", "demo_ag_frontend", "Idle"),
            ("demo_w_tech_3", "demo_ag_architect", "Idle"),
        ],
        "messages": [
            {"author": "demo_owner_tech", "kind": "owner",
             "mentions": ["demo_w_tech_3", "demo_w_tech_1"],
             "text": "新计费服务要重写，方案 A 单体 + 读写分离，方案 B 微服务按域拆分。@架构师 @后端 先给评审意见，重点看未来 2 年的扩展性与团队交付成本。"},
            {"author": "demo_ag_architect", "kind": "worker", "mentions": [],
             "text": "我倾向 B，但打折扣：按「计费 / 账单 / 对账」三个域拆，边界清晰、可独立扩容。代价是分布式事务和运维复杂度上升，需要上 saga + 消息队列。如果团队 < 8 人，A 更务实。"},
            {"author": "demo_ag_backend", "kind": "worker", "mentions": [],
             "text": "反对无脑 B。我们当前 QPS 峰值 3k，A 的读写分离能扛 5 年内。微服务的心智负担现在不值当，先把单体边界划干净（模块化解耦），等真到瓶颈再拆。演进式更稳。"},
            {"author": "demo_ag_frontend", "kind": "worker", "mentions": [],
             "text": "前端无感，但提醒一点：如果拆微服务，网关和鉴权要前置统一，别让前端对接 N 个服务。无论 A/B，请把接口契约先定下来再动。"},
            {"author": "demo_owner_tech", "kind": "owner", "mentions": [],
             "text": "采纳演进式：先 A（单体 + 清晰模块边界 + 读写分离），契约先行；埋好领域边界，18 个月内若 QPS 破 1w 再切 B。@后端 出一份模块边界与迁移里程碑。"},
            {"author": "demo_ag_backend", "kind": "worker", "mentions": [],
             "text": "收到，本周给边界图 + 三期迁移计划，契约用 OpenAPI 锁定。"},
        ],
        "summary": "【核心结论】计费服务重写采用演进式方案：先以单体 + 读写分离 + 清晰模块边界落地，预留领域边界，待 QPS 破万再切微服务。\n【各方观点】架构师主张按域微服务化但认可团队规模约束；后端工程师反对过早微服务，力主演进式与模块化解耦；前端强调接口契约先行、统一鉴权网关。\n【分歧与共识】「是否一步到位微服务」存在分歧，最终共识为演进式路线，契约先行。\n【悬而未决】具体的模块边界图与三期迁移里程碑由后端本周补全。",
    },
    {
        "gid": "demo_g_growth",
        "name": "增长攻坚小组",
        "goal": "制定并复盘 Q3 多渠道增长策略，提升获客与留存。",
        "owner": "demo_owner_growth",
        "base": now - 90 * M,
        "workers": [
            ("demo_w_growth_1", "demo_ag_growth", "Idle"),
            ("demo_w_growth_2", "demo_ag_data", "Busy"),
            ("demo_w_growth_3", "demo_ag_writer", "Idle"),
        ],
        "messages": [
            {"author": "demo_owner_growth", "kind": "owner",
             "mentions": ["demo_w_growth_1", "demo_w_growth_2"],
             "text": "Q3 增长目标 +35% 新增。预算 80w，渠道待定。@增长策略师 @数据分析师 给打法，先盘点历史各渠道 ROI。"},
            {"author": "demo_ag_growth", "kind": "worker", "mentions": [],
             "text": "建议三三制：内容种草 30%、效果广告 40%、老带新 30%。内容做长尾 SEO + 短视频；广告聚焦高意向词；老带新上阶梯奖励。预算别均摊，效果广告留 20% 机动。"},
            {"author": "demo_ag_data", "kind": "worker", "mentions": [],
             "text": "回看 Q2：信息流 ROI 2.1、搜索 3.4、老带新 5.0（但体量小）。搜索被低估了，建议加预算；品牌广告几乎零转化，可砍。内容侧自然流量占比已 22%，值得加码。"},
            {"author": "demo_owner_growth", "kind": "owner", "mentions": [],
             "text": "那就搜索加投、品牌砍掉。内容 + 老带新组合拳。@内容撰写员 配合出 10 篇痛点长文，和搜索词对齐。"},
            {"author": "demo_ag_writer", "kind": "worker", "mentions": [],
             "text": "10 篇选题已按高意向搜索词反推，覆盖「怎么选 / 避坑 / 对比」三类意图，每篇埋老带新钩子。排期 3 周，需增长侧提供词包与转化数据闭环。"},
            {"author": "demo_owner_growth", "kind": "owner", "mentions": [],
             "text": "词包明天给。整体就按「搜索主攻 + 内容承接 + 老带新裂变」推进，周度看板盯 ROI。"},
        ],
        "summary": "【核心结论】Q3 增长以「搜索主攻 + 内容承接 + 老带新裂变」为主轴，预算向高 ROI 渠道倾斜，目标 +35% 新增。\n【各方观点】增长策略师提出三三制渠道结构与机动预算；数据分析师用 Q2 ROI 证明搜索被低估、品牌广告可砍、老带新效率高但体量小；内容撰写员据此反推 10 篇搜索对齐长文。\n【分歧与共识】对「是否保留品牌广告」达成一致予以下砍；预算分配从均摊转为按 ROI 倾斜。\n【悬而未决】内容侧所需搜索词包与转化数据闭环由增长侧次日提供。",
    },
    {
        "gid": "demo_g_pr",
        "name": "舆情应急指挥部",
        "goal": "负面舆情下的跨职能协同与统一对外口径。",
        "owner": "demo_owner_pr",
        "base": now - 30 * M,
        "workers": [
            ("demo_w_pr_1", "demo_ag_media", "Busy"),
            ("demo_w_pr_2", "demo_ag_legal", "Idle"),
            ("demo_w_pr_3", "demo_ag_social", "Idle"),
        ],
        "messages": [
            {"author": "demo_owner_pr", "kind": "owner",
             "mentions": ["demo_w_pr_1", "demo_w_pr_2", "demo_w_pr_3"],
             "text": "今晚有用户截图在微博说我们「偷偷扣费」，已有 200+ 转发。@媒体关系 @法务 @社媒运营 立刻拉口径：事实、边界、对外怎么说。"},
            {"author": "demo_ag_media", "kind": "worker", "mentions": [],
             "text": "先别急着发声明。建议 1 小时内私信博主核实订单号，确认是否误扣；同时准备两版口径：误扣（全额退 + 补偿）与规则不清晰（优化提示 + 安抚）。媒体侧我同步监测是否上热搜。"},
            {"author": "demo_ag_legal", "kind": "worker", "mentions": [],
             "text": "法务底线：未经核实不认「偷偷」，避免构成自认。查条款：自动续费我们在投保页有勾选记录吗？有则用户告知义务已尽，对外可强调「明示授权」；无则先内部整改再对外。一切以截图订单事实为准。"},
            {"author": "demo_ag_social", "kind": "worker", "mentions": [],
             "text": "社媒侧我先发一条「已关注，正在核实，请私信订单号」的占位回应控评，不删不辩。准备好 FAQ 与客服话术，话题页置顶官方核实入口。绝不在事实不清时甩锅用户。"},
            {"author": "demo_owner_pr", "kind": "owner", "mentions": [],
             "text": "口径统一：先核实、不认「偷偷」、以订单事实为准。核实为真扣费则全额退 + 补偿 + 优化提示；为假则澄清 + 感谢监督。@媒体关系 牵头对外，今晚 23 点前给进展。"},
            {"author": "demo_ag_media", "kind": "worker", "mentions": [],
             "text": "明白，23 点前同步。已联系博主，等订单号。热搜暂未起，窗口期宝贵。"},
        ],
        "summary": "【核心结论】针对「疑似偷偷扣费」舆情，指挥部达成「先核实、不认偷扣、以订单事实为准」的统一对外口径，按核实结果分两版应对。\n【各方观点】媒体关系主张先私信核实、准备双版口径并监测热搜；法务划出底线——未经核实不认「偷偷」、以自动续费告知义务的事实为准；社媒运营提出占位回应控评、不删不辩、备好 FAQ。\n【分歧与共识】对「是否立即发声明」存在快慢分歧，共识为先核实再定性，事实不清时绝不甩锅用户。\n【悬而未决】订单核实结果未回，真 / 假扣费对应的退赔与澄清动作待事实落地后执行。",
    },
]


def main():
    # 1) 备份
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    bak = f"{DB}.bak_{ts}"
    shutil.copy(DB, bak)
    print(f"[backup] {bak}")

    conn = sqlite3.connect(DB)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    cur = conn.cursor()

    # 2) 幂等清理
    for tbl, col in [
        ("roundtable_summaries", "group_id"),
        ("roundtable_messages", "group_id"),
        ("workers", "group_id"),
        ("groups", "id"),
        ("agents", "id"),
    ]:
        cur.execute(f"DELETE FROM {tbl} WHERE {col} LIKE 'demo_%'")
    print("[clean] removed previous demo_* rows")

    # 3) agents
    cur.executemany(
        "INSERT INTO agents (id,name,model,system_prompt,capabilities,skills,mcp,tools,created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)", AGENT_ROWS)
    print(f"[agents] inserted {len(AGENT_ROWS)}")

    # 4) groups + workers + messages + summaries
    total_msg = 0
    total_sum = 0
    for s in SCENARIOS:
        wids = [w[0] for w in s["workers"]]
        seat_cfg = {"static": wids}
        cur.execute(
            "INSERT INTO groups (id,name,goal,owner_agent_ref,status,seat_config,created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (s["gid"], s["name"], s["goal"], s["owner"], j("Active"), j(seat_cfg), s["base"]))

        for (wid, aref, st) in s["workers"]:
            cur.execute(
                "INSERT INTO workers (id,group_id,agent_ref,seat_type,status,max_concurrency,capabilities,current_task_id,last_heartbeat) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (wid, s["gid"], aref, j("Static"), j(st), 2, j(CAPS.get(aref, [])), None, None))

        seqs = []
        t = s["base"]
        for i, m in enumerate(s["messages"]):
            t = s["base"] + i * 7 * M
            cur.execute(
                "INSERT INTO roundtable_messages (group_id,author,author_kind,content,mentions,created_at) "
                "VALUES (?,?,?,?,?,?)",
                (s["gid"], m["author"], m["kind"], m["text"], j(m["mentions"]), t))
            seqs.append(cur.lastrowid)
        total_msg += len(seqs)

        summary_ts = t + 3 * M
        cur.execute(
            "INSERT INTO roundtable_summaries (group_id,content,source_seq_start,source_seq_end,message_count,created_at) "
            "VALUES (?,?,?,?,?,?)",
            (s["gid"], s["summary"], min(seqs), max(seqs), len(seqs), summary_ts))
        total_sum += 1
        print(f"[group] {s['gid']}  messages={len(seqs)}  seq[{min(seqs)}..{max(seqs)}]")

    conn.commit()
    conn.close()
    print(f"\nDONE: agents={len(AGENT_ROWS)}  groups={len(SCENARIOS)}  "
          f"workers={sum(len(s['workers']) for s in SCENARIOS)}  "
          f"messages={total_msg}  summaries={total_sum}")


if __name__ == "__main__":
    main()
