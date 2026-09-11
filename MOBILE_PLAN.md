# 移动端打磨方案（排期 #9）

> 2026-09-06 落盘。与 PERF_PLAN.md（全站提速，另一会话）**并行开工**，本文档重点是两边的**文件边界协议**，供两个会话对齐。范围已和用户确认：全部页面（微信观赛体验优先 + 现场手机报分），先做 #9，push 听指挥。

## 两会话边界协议（先读这段）

1. **提速会话（PERF_PLAN）放心改，#9 完全不碰的前端文件**：
   - `Home.tsx`（提速包 B.3 轮询加闸）
   - `PublicTournament.tsx`（提速包 B.2 砍预热链）
   - `MatchesTab.tsx`（提速包 B.5 停赛懒加载 + act 并行化）
   - `App.tsx`（提速包 B.1 路由懒加载）
   - 这四个文件的**移动端适配 #9 全走 styles.css 覆盖，不改任何 JSX/逻辑**（tabs 横滚、报分表单单列堆叠、按钮加大都是纯 CSS 活）
2. **#9 会做 JSX 级改动的文件（PERF_PLAN 不涉及，两边安全）**：
   `index.html`、`src/api.ts`、`src/pages/PublicMatchDetail.tsx`、`src/components/ShareDialog.tsx`、`src/lib/share.ts`、`src/pages/StandingsTab.tsx`、`src/components/Toplists.tsx`、`src/components/StatsDashboard.tsx`
3. **styles.css**：#9 的主战场，提速方案不碰样式，无冲突
4. **worker/ 后端**：#9 完全不碰（提速的主战场）
5. **任务让渡**：Home 首页「无 live 不轮询」归提速改造（包 B.3），#9 不重复做
6. 双方 commit 都停本地，push/deploy 等用户指挥；#9 若实施中发现必须动第 1 条的避让文件 JSX，先停下汇报，不硬碰

## 目标场景

- **观众**：微信里点开 `/t/:id` 直链看比赛（主场景）
- **管理员**：比赛现场用手机报分/录事件（管理端唯一精雕路径）
- 其余页面保底：窄屏不横向爆版、能操作

断点策略：沿用现有 640px 主断点；战术板已有自己的移动布局不动。

## 工作项

### A. 全局地基（styles.css / index.html）
- index.html：viewport 加 `viewport-fit=cover`；补 `<meta name="theme-color">`（墨绿顶栏色）
- 表格横滚兜底：积分榜/榜单/数据页/管理端表格的现有父容器加 overflow-x 横滚（尽量纯 CSS 不改 JSX）——「不爆版」的底线
- 触摸目标：640px 下轮次 chip（现约 26px 高）、分享按钮、ghost 按钮、弹窗关闭键加高到 ≥36px

### B. 公开观赛页精雕
- **积分榜**（360-375px 会整页横向爆，诊断：10 列最小内容宽约 380-390px > 351px 可用宽）：窄屏瘦身——数字列 2.4em→约 2em、队名列 min-width 收窄、字号 13→12px、`minmax(340px,1fr)`→`minmax(0,1fr)`；父容器横滚兜底多组 11 列表
- **赛事页 5 tab 溢出**：`.tabs` 改 overflow-x 横滚（照 `.round-tabs` 成熟模式）+ tab 加触摸面积（CSS-only）
- 顶栏：登录用户 6+ 链接横向溢出 → 窄屏 nav-links 允许换行（CSS）
- 赛程卡 mr-line / 内联时间线：窄屏压缩字号与间距，减少折行膨胀（CSS，不改结构）

### C. 分享卡微信链路（重点——现在微信里存不了图）
诊断：`<a download>` 在微信 WebView 无效 + 预览是 canvas 长按不了 + 复制链接失败提示「地址栏」而微信没有地址栏。
- ShareDialog：canvas 绘完转 **`<img>` 展示**——微信里长按图片即可保存/转发/识别二维码
- 保存按钮升级：`navigator.share` 支持带图片文件时走系统分享；微信 UA（MicroMessenger）提示「长按上方图片保存或转发」；普通浏览器保留下载 PNG
- 复制链接失败时展示完整链接文本供手动复制（替换「地址栏」文案）

### D. 弱网韧性（微信弱网不炸页）
- api.ts：fetch 加 15s 超时（AbortController；Blob 上传放宽 60s），不再无限挂起
- PublicMatchDetail：**轮询失败不再把整页比分替换成报错**（仅首次加载失败显示错误；轮询失败静默保留旧数据）；完赛场停止自动轮询（省电省流量，补录场景观众刷新页面即可）

### E. 管理端（聚焦现场报分，其余保底）
- **MatchesTab 精雕（CSS-only）**：报分表单 score-form、事件表单 event-form、快速按钮组 640px 下单列堆叠、输入框全宽、按钮加大——手机单手能录事件
- 其余管理页保底：表格父容器横滚、page-head 窄屏纵排、TournamentManage tab 条横滚（CSS-only）

## 验证
- DevTools 375px + 360px 竖屏逐页截图：公开赛事页 5 tab、积分榜（单组/多组）、榜单、数据页、单场详情、主页、战术板回归、分享弹窗
- 管理端：手机宽度走一遍 报分→开 live→录事件→终场
- 弱网模拟：单场页轮询失败保留旧数据、api 超时生效
- 分享卡：img 长按（微信 UA 提示）、桌面下载、复制链接降级

## 交付
实现 → 浏览器 E2E → code review → commit 停本地不 push（与提速会话的 commit 并存，都等用户指挥）

## 明确不做
- 管理端逐页精雕（只精雕报分路径）；bracket 树状对阵图、PWA、深色模式、根字号全局流式化
- 首页 `/` 对观众开放（观赛动线维持 `/t/:id` 直链，现有产品设计不动）
- Home.tsx / PublicTournament.tsx / MatchesTab.tsx / App.tsx 的任何改动（避让提速改造）
