# Concept Relation 复用六型并要求人工确认

V3.2 的 Concept Relation 首版只允许 AI Suggestion 经用户确认后成为正式边，不提供用户直接创建。Suggestion 冻结两端 Concept、各自不可变 Concept Revision、有效 Membership 集合指纹、类型、描述、理由、置信度和模型信息；Membership 指纹由仍有效的 `{membership id, Knowledge Point id}` 按 `id:knowledgePointId` 排序、换行连接后计算 SHA-256，不另建成员快照表。正式关系复用 Knowledge Relation 六型：`SIMILAR`、`CONTRASTS`、`ANALOGY` 按 Concept ID 规范化为对称端点，`PREREQUISITE`、`EXTENDS`、`APPLIES` 保留 source → target；路径可以反向遍历，但必须同时返回规范方向和遍历方向。同一对 Concept 可以同时具有不同类型，同一规范端点、方向与类型只有一个有效关系；确认后的端点、类型、描述与确认时间不可改写，只能记录撤销。端点归档、当前 Revision 或有效 Membership 指纹变化只使关系进入 `needsReview` 并退出默认网络，不删除建议、确认或撤销历史。

其中“AI Suggestion 必须经人工确认”的入口已由 ADR-0039 取代；六型、方向、输入指纹、不可变历史与 `needsReview` 规则继续有效。

Record 永久删除是 Concept Activity 不可变性的唯一例外：删除事务使用局部授权标记，让随 Knowledge Point 删除的 Membership、对应 Membership Activity 和 Candidate 决定成员引用完成级联；普通事务直接更新或删除 Concept Activity 仍被拒绝。这样避免悬空引用，同时不把临时端点失效误当成永久删除，也不削弱日常历史保护。

知识网络继续以 PostgreSQL 只读聚合这三类真实边，不建立通用多态边表：`concept_membership`、`knowledge_relation`、`concept_relation`。公开 API 用 `concept:<uuid>` 与 `knowledge_point:<uuid>` typed key 区分节点身份；边同时返回稳定键、规范端点、是否有向、来源和确认记录，路径再单独标注正向、反向或无向遍历。局部子图固定上限为 300 个节点、600 条边和深度 2；路径固定上限为深度 6、访问 1000 个节点和 2 秒数据库查询预算。超过预算明确失败，不以相似度或虚构边补全结果；图形工作区不属于本决定，留到 V3.3。
