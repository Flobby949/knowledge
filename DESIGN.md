---
name: 个人知识气泡图谱
description: 用马卡龙色的可扩展气泡图谱呈现知识全貌，以柔和纸白工作台承载长期阅读与核验。
colors:
  strawberry: "#f39bb4"
  strawberry-deep: "#c63d68"
  strawberry-soft: "#ffe9f0"
  lilac: "#c6b5f3"
  pistachio: "#b8ddbd"
  vanilla: "#ffe29b"
  sky: "#b8d8f3"
  cloud: "#fff8fb"
  surface: "#ffffff"
  berry-ink: "#4b3542"
  berry-muted: "#766170"
  petal-border: "#ecd9e2"
  petal-border-strong: "#d8bbc8"
  success: "#3f7f5d"
  danger: "#b4233d"
typography:
  scale:
    micro: "9px"
    nano: "10px"
    caption: "11px"
    label-small: "12px"
    label: "13px"
    body-small: "14px"
    body: "15px"
    body-large: "16px"
    title-small: "17px"
    title: "18px"
    title-large: "19px"
    heading-small: "20px"
    heading: "21px"
    heading-large: "22px"
    display-small: "23px"
    display: "24px"
    display-large: "25px"
    hero-small: "26px"
    hero: "28px"
    hero-large: "30px"
    hero-xlarge: "31px"
    record-display: "36px"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Noto Sans CJK SC, Microsoft YaHei, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.02em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Noto Sans CJK SC, Microsoft YaHei, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Noto Sans CJK SC, Microsoft YaHei, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.45
rounded:
  hairline: "2px"
  tiny: "3px"
  small: "4px"
  compact: "5px"
  medium-small: "6px"
  medium: "7px"
  card-small: "8px"
  control: "9px"
  control-large: "10px"
  surface: "12px"
  chip: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.strawberry-deep}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "0 24px"
    height: "44px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.berry-ink}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "44px"
  tag-chip:
    backgroundColor: "{colors.strawberry-soft}"
    textColor: "{colors.strawberry-deep}"
    rounded: "{rounded.chip}"
    padding: "2px 9px"
---

# Design System: 个人知识气泡图谱

## Overview

**Creative North Star: “可扩展的糖果色气泡图谱”**

系统将可爱感放在颜色、比例、节奏和反馈上，而不是依赖真实马卡龙、手帐或抽屉等难以扩展的物件。首页是一张明亮、可缩放的空间画布：大量标签以简洁的彩色气泡存在，远景自动退化为小点，焦点与近景节点才显示文字。MVP 不绘制关系边；未来真实关系直接加入同一坐标系的节点下层，无需更换导航模型。

内页使用云朵纸白、深莓果正文和花瓣粉边界，草莓粉承担主要操作与焦点，淡紫、开心果、香草黄和天空蓝用于稳定的标签身份与局部节奏。内容、证据和状态始终比装饰优先。

**Key Characteristics:**

- 首页和内页共享同一浅色环境与马卡龙色彩角色。
- 图谱节点只由圆、内圈、细描边和轻偏移阴影组成，可由 WebGL、SVG 或 CSS 一致实现。
- 高密度依靠 LOD、标签碰撞隐藏和搜索聚焦解决，不使用翻页或固定格位。
- AI 候选使用虚线外圈和明确文字；状态不只依赖颜色。
- 内页保持宽屏工作台密度，不把所有内容变成松散的大圆角卡片。

## Colors

采用明亮全调色板策略，但高饱和色只用于节点身份、主操作、焦点和真实状态。页面大面积区域保持云朵纸白和纯白。

### Primary

- **草莓行动** (`#c63d68`)：主按钮、选中、键盘焦点和关键链接。
- **草莓牛奶** (`#f39bb4`)：首页节点、品牌圆环和柔和装饰，不承载白色小字号正文。
- **草莓薄雾** (`#ffe9f0`)：选中背景、悬停和轻提示。

### Secondary

- **葡萄淡紫** (`#c6b5f3`)：稳定标签身份与次级节点。
- **开心果绿** (`#b8ddbd`)：稳定标签身份与成功环境，不替代明确成功文字。
- **香草黄** (`#ffe29b`) 与 **天空蓝** (`#b8d8f3`)：节点身份和少量节奏。

### Neutral

- **云朵纸白** (`#fff8fb`)：应用背景与图谱画布。
- **纯白表面** (`#ffffff`)：导航、输入、面板和内容表面。
- **深莓果墨** (`#4b3542`)：标题与正文。
- **莓果灰** (`#766170`)：次要信息。
- **花瓣边界** (`#ecd9e2`)：分隔与静态边界。

**The Stable Identity Rule.** 标签颜色由稳定身份决定，只用于辨识，不暗示类别、热度、认可状态或关系。

**The Honest Graph Rule.** V1 不绘制关系边、邻居高亮或语义聚类；位置与距离没有关系含义。

## Typography

标题、正文、摘要、标签和控件统一使用系统中文无衬线栈。层级依靠字号、字重与留白建立，不用展示性衬线、手写体或等宽字体扮演可爱感。

- **Headline**：28px / 700 / 1.35，用于页面与记录标题。
- **Title**：16–20px / 650–700，用于知识点、卡片和面板标题。
- **Body**：15px / 400 / 1.65，正文阅读宽度约 65–75 个英文字符。
- **Label**：12–13px / 600，用于状态、筛选、时间和证据数量。

密集工作台保留 9–36px 的已校准离散字号阶梯；9–11px 只用于非关键微型标记，正文不得低于 14px。新增界面优先使用 12、13、15、16、18、20、24、28、36px，其他阶梯用于兼容已有信息密度与精确几何。

## Layout

PC Web 最低验收宽度为 1280px，主要优化 1440–1920px。所有页面使用 60px 横向顶部导航，不设常驻侧边栏。首页导航以下占满视口；内页维持现有工作台结构：记录库真瀑布流、详情与审查约 58/42 双区、搜索和标签使用推挤式右侧面板、设置保持单页纵向控制台。

首页节点数量增加时按 LOD 逐级降低节点尺寸、隐藏非焦点标签并减少装饰粒子；搜索在同一画布内聚焦结果，不引入分页。间距遵循“组内紧、组间松”，标题上方留白多于下方。

## Elevation & Depth

图谱通过节点尺度、遮挡、透明度和轻微偏移阴影建立空间。内页默认平面，以纸白层级和细边界组织信息；阴影只用于悬浮控件、弹层、推挤面板边界和真实悬停反馈。

**The Soft Offset Rule.** 阴影必须有明确向下偏移与柔和模糊；禁止零偏移霓虹光晕。

## Shapes

图谱节点为正圆与同心内圈；已认可标签使用完整外圈，AI 候选使用虚线外圈。2–7px 用于微型控件和紧凑内部元素，基础控件采用 8–10px 圆角，主要内容表面不超过 12px；胶囊只用于短标签、筛选和小状态。内容容器不复制图谱节点造型。

## Components

### Buttons

- 主按钮使用深草莓色、白字、9px 圆角；悬停进一步加深。
- 次按钮保持白底、花瓣边界和深莓果文字。
- 焦点统一使用 2px 深草莓轮廓，不用颜色变化代替键盘状态。

### Chips

- 标签芯片使用淡粉、淡紫、淡绿、淡黄或淡蓝的低饱和背景；文字使用深莓果或对应深色。
- 认可状态必须同时出现文字或图形；AI 候选使用虚线轮廓。

### Cards / Containers

- 静态卡片以纯白和花瓣边界成立，圆角 8–12px。
- 只有悬停或真实浮层出现偏移阴影；避免边框与重阴影同时使用。

### Inputs / Fields

- 白底、花瓣边界、9px 圆角；聚焦时切换为深草莓边界并出现轻粉焦点层。
- 占位文字使用可读的莓果灰，错误和禁用状态保留明确文字说明。

### Navigation

- 所有页面共享白色横向导航、草莓色活动下划线和同心圆品牌标记。
- 首页不再使用深色导航变体。

### Bubble Node

- WebGL 与 2D 回退必须共享同一正圆、内圈、颜色、完整／虚线状态语言。
- 标签密度提升时先隐藏文字，再缩小节点；焦点节点始终可读并支持键盘访问。

## Do's and Don'ts

### Do:

- **Do** 让首页保持一张连续、可缩放、未来可叠加真实关系边的画布。
- **Do** 在内页复用云朵纸白、深莓果文字、花瓣边界和草莓焦点。
- **Do** 使用真实中文内容长度检查截断、阅读宽度和工作台密度。
- **Do** 为减少动态效果和 WebGL2 不可用提供完整静态等价状态。

### Don't:

- **Don't** 把节点做成真实马卡龙、贴纸、活页、抽屉或其他高成本物件。
- **Don't** 通过翻页、固定格位或装饰线解决大量标签导航。
- **Don't** 使用深空科幻、霓虹、玻璃拟态、全光谱彩虹或儿童玩具式角色。
- **Don't** 用大圆角重阴影 SaaS 卡片、嵌套卡片或无意义指标面板填满内页。
- **Don't** 在 V1 用位置、连线、邻居高亮或聚类暗示尚不存在的知识关系。
