---
status: accepted
---

# 每个 AI Knowledge Point 都保存原文证据

每个 AI 生成的 Knowledge Point 必须引用一个或多个 Evidence Span，且这些片段能在同一知识点引用的 Fragment Revision 中精确定位和高亮；证据缺失或无法匹配会使整版 AI 输出校验失败。Fragment 级 AI 标题与整体摘要以完整 Fragment Revision 为依据，不单独保存局部证据。这个设计增加了知识点生成协议和存储复杂度，但把“有据整理”变成用户可核验、系统可确定性校验的约束，而不是只依赖提示词或模型置信度。

Evidence Span 只核验不可变的 AI 原始知识点。用户修正可以加入原文没有的内容，界面必须把它标为用户撰写，并将证据入口明确限定为 AI 原值的证据，不能暗示同一片段为用户补充背书。
