---
status: accepted
---

# 已发布知识点的不采用是可撤销的正交状态

用户可以对 `AUTO_PUBLISHED` 或 `CONFIRMED` 的 Knowledge Point 执行“不采用”，使其退出当前有效知识视图、默认搜索和知识点级标签聚合；该操作可随时恢复，不物理删除 AI 原值、用户修正、Evidence Span、版本引用或历史数据。V1 用独立的 `usage_status = INCLUDED | EXCLUDED` 表达是否当前使用，不覆盖知识点原有 `publication_status`，因此恢复时无需猜测它此前是自动发布还是用户确认。

Mode B 发布前的 `REJECTED` 继续表示审查拒绝，与发布后的可撤销排除分开。这个双维度模型增加了一个状态字段，但保住了发布来源的审计语义，并为用户提供了纠正 Mode A 错误结果而不破坏历史的低成本动作。

排除只绑定到该确切 Knowledge Point，不构成跨 AI Analysis Revision 的偏好或规则。重新分析和原文编辑不读取、不匹配也不迁移旧 `EXCLUDED` 状态，不会因此把 Mode A 改为人工审查；新版本知识点默认 `INCLUDED`，即使内容相似也可再次出现。旧排除状态只随旧知识点留在历史中，不产生运行时影响。
