---
status: accepted
---

# 用户标签与 AI 标签共用一个 Tag 词表

用户创建的标签和 AI 生成的候选标签使用同一实例级 Tag 对象，通过不可变 `origin` 与可变 `approval_status` 区分来源和认可状态；标签库只是 `USER_APPROVED` Tag 的视图。Tag Assignment 独立保留目标、分配者、分析版本和 AI 原始文本。用户升级候选时复用同一 `tag_id`，所有历史关联立即指向已认可标签，但不把 AI 关联伪装成用户逐条确认。

统一词表不等于挂载权限相同。V1 中用户手动创建的 Tag Assignment 只允许指向整条 Record，AI Assignment 只允许指向 Knowledge Point；用户不能手动给单个 Knowledge Point 添加标签，只能升级候选 Tag 或屏蔽、恢复 AI Assignment。同一 Tag 可以同时由用户挂到记录、由 AI 挂到知识点，聚合展示时去重，但两条 Assignment 的来源事实分别保留。

当前实例内标准化同名标签共用唯一身份。`normalized_name` 使用确定性文本规则：Unicode NFKC、去除首尾空白、连续内部空白折叠为一个空格，以及拉丁字母大小写无关比较；它保留标点，不翻译、不执行词干化、缩写展开或同义词判断，`display_name` 则独立用于展示。因此 ` CDC `、`cdc` 和 `ＣＤＣ` 共用身份，`C.D.C.` 与 `Change Data Capture` 仍保持独立。V1 的同名异义使用明确名称区分，不同名称的同义词暂不合并，相关合并与别名能力留到 V2。

当用户创建或重命名 Tag 而 `normalized_name` 已存在时，系统把操作视为重名并拦截，不创建重复身份，也不把新输入的写法覆盖到现有 `display_name`；用户可以改为选择已有 Tag。候选升级保留原展示名。AI 生成同名变体时复用已有 Tag，仅在 Tag Assignment 的 `raw_label` 中保留本次写法，不能修改展示名。只有用户显式重命名才能改变 `display_name`，且重命名同样必须满足标准化名称唯一约束。

删除关联后，无其他关联的候选 Tag 自动删除，无其他关联的已认可 Tag 继续保留在标签库。这个模型避免两套标签表、复制升级和历史批量回写，同时保留完整审计语义。
