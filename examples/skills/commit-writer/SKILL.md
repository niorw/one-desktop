---
name: commit-writer
description: 根据当前 git 暂存差异生成符合 Conventional Commits 规范的提交信息
version: 1.0.0
---

# commit-writer

读取 `git diff --cached`，结合仓库近期提交风格，生成一条简洁、可追溯的 Conventional Commits 提交信息。

## 适用场景
- 提交前不确定怎么概括改动
- 希望保持团队提交风格一致

## 用法
传入仓库路径，工具执行 `git diff --cached` 并返回建议的 commit message，例如：

```
feat(skill): add commit-writer skill for staged diff summary
```

> 本文件为示例技能，用于验证 OneDesktop 的本地技能导入（import_skill_local）流程。
