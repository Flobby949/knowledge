---
status: accepted
---

# 用户修改 Fragment 时创建不可变版本

Knowledge Fragment 是用户持续维护的逻辑对象，首次保存和每次编辑都会创建不可变的 Fragment Revision；AI 分析和知识点必须引用确切的来源版本。我们不采用完全禁止修改，因为用户需要纠错和补充；也不允许直接覆盖，因为那会破坏原文、AI 结果和用户知识之间的可追溯关系。
