---
name: 个人知识双主题图谱
description: 在同一知识交互模型上提供马卡龙气泡与科幻信号场两套完整视觉主题。
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
  space: "#00030b"
  archive-paper: "#f7f9fc"
  archive-ink: "#0b1533"
  signal-blue: "#005ff9"
  neural-cyan: "#39c6ff"
  neural-violet: "#7e74ff"
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

# Design System: 个人知识双主题图谱

## Overview

**Creative North Star: “同一知识宇宙，两种完整视觉语言”**

系统以马卡龙气泡为默认主题，同时完整保留原科幻信号场。主题只改变视觉材料和首页渲染语法，不改变信息架构、稳定节点坐标、LOD、搜索、状态、键盘行为或内容。马卡龙主题把可爱感放在颜色、比例、节奏和反馈上；科幻主题使用深空、膜状节点、冷调档案内页和克制信号辉光。

马卡龙内页使用云朵纸白、深莓果正文和花瓣粉边界；科幻内页使用冷调纸白、深蓝墨色、蓝灰边界和电蓝操作信号。内容、证据和状态始终比装饰优先，主题选择在当前浏览器持久化且刷新时不得闪烁。

**Key Characteristics:**

- 每套主题在首页和内页内部保持完整一致，不在同一页面混用两套视觉语法。
- 马卡龙节点使用正圆、内圈、细描边和轻偏移阴影；科幻节点使用膜状轮廓、同心信号层和端口。
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

### Sci-fi Theme

- **深空** (`#00030b`)：科幻首页画布。
- **档案纸白** (`#f7f9fc`) 与 **档案墨色** (`#0b1533`)：科幻内页背景和正文。
- **电蓝信号** (`#005ff9`)：科幻主题的主操作、焦点和活动导航。
- **神经青** (`#39c6ff`) 与 **神经紫** (`#7e74ff`)：膜状节点身份和信号反馈。

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

图谱通过节点尺度、遮挡和透明度建立空间。马卡龙使用轻微偏移阴影；科幻使用有边界的局部辉光和深空雾化。内页默认平面，以主题纸白层级和细边界组织信息；阴影只用于悬浮控件、弹层、推挤面板边界和真实悬停反馈。

**The Soft Offset Rule.** 阴影必须有明确向下偏移与柔和模糊；禁止零偏移霓虹光晕。

## Shapes

马卡龙图谱节点为正圆与同心内圈；科幻节点为可复现的膜状轮廓和同心信号层。已认可标签使用完整外圈，AI 候选使用虚线外圈。2–7px 用于微型控件和紧凑内部元素，基础控件采用 8–10px 圆角，主要内容表面不超过 12px；胶囊只用于短标签、筛选和小状态。

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

- 所有页面共享同一横向导航结构、搜索和主题快捷切换；颜色随主题变化。
- 马卡龙使用白色导航、草莓活动线和同心气泡标记；科幻首页使用深色导航、冷光活动线和轨道标记，内页延续冷调档案语法。

### Bubble Node

- WebGL 与 2D 回退必须共享同一正圆、内圈、颜色、完整／虚线状态语言。
- 标签密度提升时先隐藏文字，再缩小节点；焦点节点始终可读并支持键盘访问。

### Theme Switching

- 设置页提供两个带真实视觉预览的单选项，顶栏提供快捷切换；两者必须保持同步。
- 选择写入 `knowledge.theme.v1`，在应用脚本执行前恢复根节点主题，避免刷新闪回。
- 主题切换必须销毁并重建对应 WebGL 场；镜头、搜索、焦点和 URL 行为保持不变。

## Do's and Don'ts

### Do:

- **Do** 让首页保持一张连续、可缩放、未来可叠加真实关系边的画布。
- **Do** 在内页复用云朵纸白、深莓果文字、花瓣边界和草莓焦点。
- **Do** 使用真实中文内容长度检查截断、阅读宽度和工作台密度。
- **Do** 为减少动态效果和 WebGL2 不可用提供完整静态等价状态。

### Don't:

- **Don't** 把节点做成真实马卡龙、贴纸、活页、抽屉或其他高成本物件。
- **Don't** 通过翻页、固定格位或装饰线解决大量标签导航。
- **Don't** 把科幻主题简化成马卡龙界面的深色反相，也不要把两套主题的节点、阴影或导航语法混在同一页面。
- **Don't** 用大圆角重阴影 SaaS 卡片、嵌套卡片或无意义指标面板填满内页。
- **Don't** 在 V1 用位置、连线、邻居高亮或聚类暗示尚不存在的知识关系。
