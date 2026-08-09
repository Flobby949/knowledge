---
status: accepted
---

# 保存 Fragment 不强制执行 AI 整理

用户保存 Fragment 时可以选择“仅保存”，也可以请求 AI 整理；默认选择“AI 整理 + Mode A”，用户可以为单条 Fragment 显式改为仅保存或 Mode B。仅保存的 Fragment 可以没有 AI Analysis Revision 和 Knowledge Point，但原文仍参与搜索，并可在以后主动整理。Mode A/B 只决定 AI 结果的发布方式，不决定是否调用 AI；这个边界保留了快速记录场景，也避免用户为一次单纯保存承担不必要的延迟、成本和结构化结果。
