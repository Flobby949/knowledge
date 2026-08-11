---
name: 个人知识双主题图谱
description: 以知识阅读为中心，在同一交互模型上提供马卡龙气泡与科幻档案两套完整视觉主题。
colors:
  strawberry: "#f39bb4"
  strawberry-deep: "#c63d68"
  strawberry-soft: "#ffe9f0"
  strawberry-orbit: "#ffdbe5"
  strawberry-ring: "#ff668c"
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
  workspace-canvas: "#fffdfd"
  workspace-panel: "#fff7fa"
  workspace-panel-strong: "#fceff4"
  workspace-rail: "#fffafb"
  workspace-line: "#f0dfe6"
  workspace-line-strong: "#dbbdc9"
  workspace-ink: "#39232e"
  workspace-muted: "#7d6371"
  workspace-accent: "#de245a"
  workspace-accent-hover: "#c71549"
  workspace-accent-soft: "#fff0f5"
  workspace-evidence: "#ffe58b"
  workspace-marker-1: "#ff3f70"
  workspace-marker-2: "#69b64d"
  workspace-marker-3: "#5e9eea"
  space: "#00030b"
  archive-paper: "#f7f9fc"
  archive-ink: "#0b1533"
  signal-blue: "#005ff9"
  neural-cyan: "#39c6ff"
  neural-violet: "#7e74ff"
  archive-navigation-ink: "#20314f"
  archive-control-border: "#cdd9e9"
  archive-port-border: "#8ba2c1"
  signal-cobalt-muted: "#168bc9"
  signal-soft: "#73a6f5"
  membrane-border: "#83badf"
  membrane-inner: "#4f9ed2"
  membrane-core: "#0077c8"
  membrane-counter-border: "#bfd0ee"
  signal-prompt-border: "#8fb3df"
  signal-orbit: "#8ab9e3"
  signal-orbit-inner: "#62a6d7"
  signal-orbit-core: "#087fc6"
  scifi-workspace-canvas: "#f8faff"
  scifi-workspace-panel: "#f1f5fb"
  scifi-workspace-panel-strong: "#e7eef8"
  scifi-workspace-rail: "#f3f6fb"
  scifi-workspace-line: "#d8e2f0"
  scifi-workspace-line-strong: "#aebfd6"
  scifi-workspace-ink: "#0b1734"
  scifi-workspace-muted: "#5b6b87"
  scifi-workspace-accent-hover: "#0052d8"
  scifi-workspace-accent-soft: "#eaf2ff"
  scifi-workspace-evidence: "#bcefff"
  scifi-workspace-marker-2: "#0a9db2"
  scifi-workspace-marker-3: "#7259f5"
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
    record-display-large: "40px"
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

**Creative North Star: “同一知识工作台，两种完整视觉语言”**

系统以马卡龙气泡为默认主题，同时完整保留科幻信号场。主题只改变视觉材料和首页渲染语法，不改变信息架构、稳定节点坐标、LOD、搜索、状态、键盘行为或内容。马卡龙主题把亲和力放在颜色、比例、节奏和反馈上；科幻主题使用深空、膜状节点、冷调档案内页和克制信号辉光。

内页采用“知识工作台”结构：窄侧轨负责稳定去向，顶部命令带承载搜索与全局动作，主画布只服务当前任务。马卡龙内页使用云朵纸白、深莓果正文和花瓣粉边界；科幻内页使用冷调档案纸、深蓝墨色、蓝灰边界和电蓝操作信号。内容、证据和状态始终比装饰优先，主题选择在当前浏览器持久化且刷新时不得闪烁。

**Key Characteristics:**

- 每套主题在首页和内页内部保持完整一致，不在同一页面混用两套视觉语法。
- 内页先显示用户正在阅读或处理的知识，来源、历史和次级治理信息按需展开。
- 无内容状态会改变画布结构，而不是保留一块无意义的空栏。
- 马卡龙节点使用正圆、内圈、细描边和轻偏移阴影；科幻节点使用膜状轮廓、同心信号层和端口。
- 高密度依靠 LOD、标签碰撞隐藏和搜索聚焦解决，不使用翻页或固定格位。
- AI 候选使用虚线外圈和明确文字；状态不只依赖颜色。
- 内页保持宽屏工作台密度，不把所有内容变成松散的大圆角卡片。

## Colors

采用明亮全调色板策略，但高饱和色只用于节点身份、主操作、焦点和真实状态。页面大面积区域保持云朵纸白和纯白。

### Primary

- **工作台草莓行动** (`#de245a`)：内页主按钮、选中、键盘焦点和关键链接；悬停使用 `#c71549`，轻环境使用 `#fff0f5`。
- **首页草莓行动** (`#c63d68`)：首页图谱与既有气泡控件的稳定身份色。
- **草莓牛奶** (`#f39bb4`)：首页节点、品牌圆环和柔和装饰，不承载白色小字号正文。
- **草莓薄雾** (`#ffe9f0`)：选中背景、悬停和轻提示。

### Secondary

- **葡萄淡紫** (`#c6b5f3`)：稳定标签身份与次级节点。
- **开心果绿** (`#b8ddbd`)：稳定标签身份与成功环境，不替代明确成功文字。
- **香草黄** (`#ffe29b`) 与 **天空蓝** (`#b8d8f3`)：节点身份和少量节奏。

### Neutral

- **首页云朵纸白** (`#fff8fb`)：首页图谱画布。
- **工作台云朵纸白** (`#fffdfd`)：马卡龙内页主画布；分区使用 `#fff7fa` 与 `#fceff4`，侧轨使用 `#fffafb`。
- **纯白表面** (`#ffffff`)：导航、输入、面板和内容表面。
- **工作台深莓果墨** (`#39232e`)：内页标题与正文；次要信息使用 `#7d6371`。
- **首页深莓果墨** (`#4b3542`) 与 **莓果灰** (`#766170`)：首页和既有气泡信息。
- **工作台花瓣边界** (`#f0dfe6`) 与强调边界 (`#dbbdc9`)：内页分隔与静态边界。
- **首页花瓣边界** (`#ecd9e2`)：首页和既有气泡边界。

### Sci-fi Theme

- **深空** (`#00030b`)：科幻首页画布。
- **科幻工作台纸白** (`#f8faff`) 与 **工作台墨色** (`#0b1734`)：科幻内页背景和正文；分区、侧轨和边界分别使用 `#f1f5fb`、`#e7eef8`、`#f3f6fb`、`#d8e2f0`、`#aebfd6`。
- **档案纸白** (`#f7f9fc`) 与 **档案墨色** (`#0b1533`)：既有科幻图谱及兼容界面的基础色。
- **电蓝信号** (`#005ff9`)：科幻主题的主操作、焦点和活动导航。
- **神经青** (`#39c6ff`) 与 **神经紫** (`#7e74ff`)：膜状节点身份和信号反馈。
- **档案蓝灰阶** (`#20314f`、`#cdd9e9`、`#8ba2c1`)：导航文字、输入边界和端口边界。
- **信号膜层阶** (`#168bc9`、`#73a6f5`、`#83badf`、`#4f9ed2`、`#0077c8`、`#bfd0ee`、`#8fb3df`、`#8ab9e3`、`#62a6d7`、`#087fc6`)：只用于同心膜层、编号、轨道和整理提示的层次，不承载正文。

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

PC Web 最低验收宽度为 1280px，主要优化 1440–1920px。首页保留 60px 横向导航和连续图谱画布；内页使用约 76px 常驻侧轨与约 72px 顶部命令带。侧轨只放稳定去向，命令带只放搜索、创建、任务与主题等全局动作，页面级动作紧贴当前内容顶部。

记录详情和审查默认使用约 60/40 的来源／知识双区；选择知识点后才在来源区显示对应证据。仅保存原文且没有知识点时，取消知识点整列，切为统一阅读画布并在右上放置紧凑的整理提示。搜索与标签继续使用按需推挤式详情面板；设置使用单页纵向分区。记录库使用“排序首条阅读锚点 + 三列错落摘录流”，依靠留白、短标记和内容高度形成节奏，不使用贯穿全页的列线或规则横行；任务和治理列表继续使用连续行与分隔带。

首页节点数量增加时按 LOD 逐级降低节点尺寸、隐藏非焦点标签并减少装饰粒子；搜索在同一画布内聚焦结果，不引入分页。间距遵循“组内紧、组间松”，标题上方留白多于下方。

## Elevation & Depth

图谱通过节点尺度、遮挡和透明度建立空间。马卡龙使用轻微偏移阴影；科幻使用有边界的局部辉光和深空雾化。内页默认平面，以主题纸白色场、细分隔线和少量主题标记组织信息；阴影只用于悬浮控件、弹层、推挤面板边界和真实悬停反馈。大面积内容区域不得同时依赖边框、圆角和阴影来成立。

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
- 记录状态中，绿色实心勾只表示“AI 整理完成”；“仅保存”使用中性空心标记，处理中、失败与归档分别使用省略号、感叹号与短横线，状态不能只靠颜色区分。

### Inputs / Fields

- 白底、花瓣边界、9px 圆角；聚焦时切换为深草莓边界并出现轻粉焦点层。
- 占位文字使用可读的莓果灰，错误和禁用状态保留明确文字说明。

### Navigation

- 首页保留横向导航；内页共享侧轨、顶部搜索命令带和主题快捷切换，结构与键盘顺序在两套主题中一致。
- 马卡龙侧轨使用白色花瓣纸、草莓活动块与同心气泡标记；科幻侧轨使用冷调档案纸、蓝色信号端口与细轨道标记。科幻内页不是马卡龙界面的暗色反相。

### Knowledge Point & Evidence

- 知识点顶部使用紧凑的主题标记、标题、数量和处理状态，不使用独立大标题卡。
- 知识点按阅读顺序编号；选择后，来源区的证据使用同号标记和高亮。证据默认收起，按需出现。
- “仅保存原文”模块是紧凑的下一步提示，明确说明原文可搜索、AI 不会覆盖原文，并提供整理操作。

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
- **Do** 让页面结构随内容状态适配；空的知识点区域必须让位给原文或下一步操作。
- **Do** 把记录、搜索结果、任务和治理项组织成连续信息流，以分隔线和主题标记建立节奏。
- **Do** 使用真实中文内容长度检查截断、阅读宽度和工作台密度。
- **Do** 为减少动态效果和 WebGL2 不可用提供完整静态等价状态。

### Don't:

- **Don't** 把节点做成真实马卡龙、贴纸、活页、抽屉或其他高成本物件。
- **Don't** 通过翻页、固定格位或装饰线解决大量标签导航。
- **Don't** 把科幻主题简化成马卡龙界面的深色反相，也不要把两套主题的节点、阴影或导航语法混在同一页面。
- **Don't** 用大圆角重阴影 SaaS 卡片、嵌套卡片或无意义指标面板填满内页。
- **Don't** 把来源历史做成常驻时间脊柱；历史是按需工具，知识点才是详情页的主要判断对象。
- **Don't** 在 V1 用位置、连线、邻居高亮或聚类暗示尚不存在的知识关系。
