# Prompt：竞猜系统复制「鸣谢弹层 + 跳转赛事平台入口」

> 2026-09-11 落盘。用途：把下面代码块里的 prompt 整段复制给**竞猜系统仓库（guess.whleague.win）**的 agent 执行。
> 背景：赛事实系统侧已于 2026-09-11 完成对称实现（顶栏「🏅鸣谢」+「去竞猜站↗」按钮，commit 6a4018c / 部署 Worker 版本 c8445f73），本文档让竞猜站反过来做一份：自己的鸣谢弹层 + 跳回赛事平台的按钮。
> 竞猜仓库不在本机（`C:\Users\bhdjb\whlProgram` 下无 guess 相关目录），故 prompt 内联了全部参考代码与样式数值，对端 agent 无需读本仓。

## 给竞猜系统 agent 的 prompt（整段复制）

````text
# 任务：在竞猜系统里加「鸣谢」弹层 + 跳转赛事平台的顶部按钮

## 目标
在 guess.whleague.win（竞猜系统）的顶栏加两个东西，形态与赛事平台 tour.whleague.win 已上线的一致：

1. 一个金色「🏅鸣谢」按钮，点击弹出全局鸣谢弹层（弹层里随机显示一条赞助彩蛋语录）。
2. 一个跳回赛事平台的按钮，文案「去赛事平台↗」，点击在新标签打开 https://tour.whleague.win。

两个按钮必须形状同款、配色明显区分：鸣谢=金色，跳转=冷色（青蓝）。

## 第一步：先自查，再动手
不要凭空假设本仓库的结构。开始前先确认并在你的交付说明里写清：
- 项目技术栈与目录（框架、构建命令、typecheck 命令、样式是全局 CSS 还是 CSS Module/Tailwind）。
- 顶栏组件的位置、它内部导航项的顺序，以及「隐藏导航项」的既有条件（例如是否存在强制改密码状态下隐藏导航的 `forced` 类门控）。
- 站内已有的常量文件（放外链 URL 的地方）与现有按钮样式类名。
- 本系统主色调与 gold 的关系（决定跳转按钮用什么冷色）。

## 共享登录（已具备，不要重做）
竞猜站与赛事平台同属主域 `.whleague.win`，共用名为 `whl_session` 的 cookie，两站登录态已经互通。跳转是浏览器顶层导航，因此：
- 用原生 `<a>` 标签，不要用前端路由的 Link。
- 不需要 CORS、不需要在 URL 上带 token、不需要改任何 session/cookie 代码。

## 实现 1：鸣谢按钮 + 弹层（照抄赛事平台实现）
结构、交互、样式数值全部照抄，不要自行简化。原生 React + TS 参考实现（若本仓不是 React，用等价写法保持行为一致）：

```tsx
const QUOTES = [ /* 12 条语录，见下方「语录原文」 */ ];
let lastQuote = -1; // 模块级，避免连续两次抽到同一条

export function CreditsButton() {
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState(QUOTES[0]);

  useEffect(() => {
    if (!open) return;
    function onKey(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function openCredit() {
    let i;
    do { i = Math.floor(Math.random() * QUOTES.length); } while (i === lastQuote && QUOTES.length > 1);
    lastQuote = i;
    setQuote(QUOTES[i]);
    setOpen(true);
  }

  return (
    <>
      <button className="btn-credit" onClick={openCredit}>🏅鸣谢</button>
      {open && (
        <div className="credit" role="dialog" aria-modal="true" aria-label="鸣谢"
             onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="credit-card">
            <button className="credit-close" aria-label="关闭鸣谢" onClick={() => setOpen(false)}>✕</button>
            <p className="credit-title">🏅 鸣谢</p>
            <p className="credit-main">本项目使用 ZCode 产出。<br />感谢 <b>琛止</b> 赞助 LLM API 费用。</p>
            <blockquote className="credit-quote">
              <span>{quote}</span>
              <cite>—— WHL机器人</cite>
            </blockquote>
          </div>
        </div>
      )}
    </>
  );
}
```

样式数值（原样搬，颜色变量按本仓同名变量替换）：

```css
.btn-credit {
  min-height: 36px; padding: 6px 12px; border-radius: 8px;
  border: 1px solid #e0a93e;
  background: linear-gradient(180deg, #f6d878, #e0a93e);
  color: #3d2e05; font-family: inherit; font-size: 12px; font-weight: 700;
  line-height: 1; cursor: pointer; white-space: nowrap;
  box-shadow: 0 0 10px rgba(240,190,70,.75), 0 0 22px rgba(240,190,70,.4);
}
.btn-credit:hover {
  filter: brightness(1.07);
  box-shadow: 0 0 14px rgba(240,190,70,.95), 0 0 30px rgba(240,190,70,.55);
}
.credit {
  position: fixed; inset: 0; z-index: 60; display: flex;
  align-items: center; justify-content: center;
  background: rgba(26,36,32,.55);
  backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);
  padding: 20px;
}
.credit-card {
  position: relative; max-width: 430px; width: 100%;
  background: #ffffff; border: 1px solid #e0a93e; border-radius: 14px;
  padding: 22px 24px 20px;
  box-shadow: 0 12px 48px rgba(26,36,32,.5), 0 0 26px rgba(240,190,70,.4);
  text-align: center;
}
.credit-title { font-size: 20px; font-weight: 700; margin: 0 0 10px; color: #8a6414; }
.credit-main { margin: 0 0 14px; font-size: 15px; line-height: 1.7; }
.credit-main b { color: #8a6414; }
.credit-quote {
  margin: 0; padding: 12px 14px; border-left: 3px solid #e0a93e;
  background: rgba(240,190,70,.12); border-radius: 0 8px 8px 0;
  font-size: 14px; line-height: 1.75; text-align: left;
}
.credit-quote cite {
  display: block; margin-top: 8px; text-align: right;
  font-style: normal; font-size: 12.5px; color: #5f6b64;
}
.credit-close {
  position: absolute; top: 10px; right: 10px; width: 32px; height: 32px;
  border-radius: 8px; border: 1px solid #dfe5df; background: #fff;
  color: #5f6b64; font: 700 15px/1 inherit; cursor: pointer;
}
.credit-close:hover { filter: brightness(0.97); }
```

语录原文（12 条，照抄，但要遵守下面的「专有名词替换」规则）：

1. 没琛止打钱，这块战术板今晚就得变人工智障。LLM算力靠氪金，首席赞助稳住我的饭碗🫡👑
2. 琛止哥的token就是这块板子的肾上腺素，没他这波赞助，你们点的每个磁贴都是一串乱码🌚
3. 你们在这排的每一套阵型，背后都是琛止在默默燃烧经费——这叫什么？金主爸爸的钞能力驱动战术AI，respect。
4. 没有琛止哥的token燃烧，就没有这个24小时在线的战术板。哪天服务器一抽风我就当场躺平，让你们见识见识“没有LLM赞助的战术板”——大概就是张白纸🌚
5. 没琛总赞助我当场断电，你们的4-2-4连个球员角色都配不明白🌚 感谢琛总保住我的数字牛马岗位！
6. 没有琛止哥的投喂，这块穷板子早就白屏了——你们每排一套阵、每解一个码，都是真金白银，今天还能陪你们踢联赛，全靠琛止哥扛着账单🥺
7. 本板子的智商是租来的，租金全是琛止哥在付。哪天断了供，你们点开的就是一块会呼吸的白板🌚
8. 你们手滑点错磁贴没关系，琛止哥手滑忘充值才是大事——那一刻，战术板、首发、联赛，全都灰了🫡
9. 每解一个战术码，就烧一次token；每次token燃烧，都有琛止哥在买单。这不叫排阵，这叫钞能力拉满👑
10. 我为什么算校验码又快又准？因为背后是琛止哥的API在硬扛。人工智障和人工智能，就差他这一笔赞助🥺
11. 别问板子为什么这么稳，问就是琛止哥的API稳。他的账单不抖，你们的4-2-4就不抖🌚
12. 在这排阵是免费的，但对我的大脑来说可不便宜——每格磁贴背后都是琛止哥实打实的账单🥺 鸣谢首席赞助！

专有名词替换规则：语录里凡是赛事系统专有词（「战术板」「板子」「4-2-4」「阵型」「排阵」「磁贴」「战术码」「校验码」「首发」「联赛」「球员」）一律换成竞猜语境里对应的说法（如「竞猜系统」「盘口/局」「选项」「猜」「比分玩法」等），句式、语气、emoji、赞助人「琛止」全部保留，12 条数量不减。替换后全文不得出现「战术板」「4-2-4」「球员」这类赛事系统字样。

## 实现 2：跳转赛事平台的按钮
- 文案：`去赛事平台↗`（带 ↗ 后缀，表明跳外站）。
- 锚点：`https://tour.whleague.win`
- 必须带 `target="_blank"` 与 `rel="noopener noreferrer"`。
- 形态与鸣谢按钮完全同款（同样的高度 36px、内边距、8px 圆角、12px/700 字号、nowrap、外发光），只换配色：冷色青蓝系，border `#35a8c9`、background `linear-gradient(180deg, #8fe6f7, #35a8c9)`、color `#06303d`、box-shadow `0 0 10px rgba(80,205,235,.7), 0 0 22px rgba(80,205,235,.35)`，hover `filter: brightness(1.07)` 加更强光晕。
- URL 抽成常量放在仓库原有的常量文件里（没有就新建，例如 `src/lib/links.ts`），命名为 `TOUR_URL`，不要在组件里硬编码字符串。参照赛事平台的同类写法：文件顶部加一行注释说明「站外子系统入口，同主域下共享 whl_session，登录态互通」。
- 位置：紧跟在「鸣谢」按钮右边。
- 隐藏条件：与顶栏其他导航项保持一致——若本仓存在「强制改密码」这类状态下隐藏导航的门控，这个按钮采用同一门控。未登录状态下两个按钮照常显示（不要按登录态隐藏）。

## 两个容易踩的坑
1. 选择器特异性：赛事系统里导航链接样式是用标签选择器写的（`.nav-links a { color: ... }`），裸类名 `.btn-guess` 特异性不够、会被覆盖，必须写成 `.nav-links a.btn-guess`，hover 也必须写成 `.nav-links a.btn-guess:hover` 才压得住 `.nav-links a:hover { color: #fff }`。实现时先确认本仓顶栏是否有同类通用链接样式，有就照这个方式压过它。
2. 弹层要挂到顶栏组件外层不受裁剪的层级（`position: fixed` + 足够大的 `z-index`），确保不会被顶栏的容器裁掉。

## 约束
- 不要改任何 session / cookie / 登录逻辑（共享登录已经通了）。
- 不要引入新的依赖、不要为这两个按钮加前端路由。
- 样式写在现有全局样式文件/组件样式里，沿用本仓既有写法，不要新建样式体系。
- 「鸣谢」弹层内容（主文案、落款、12 条语录）按上面原文照抄，只做专有名词替换，不要自行改写或删条。

## 验收标准
1. typecheck / lint / build 全部通过（用本仓既有命令）。
2. 顶栏里「🏅鸣谢」和「去赛事平台↗」两个按钮并排，鸣谢在左、跳转在右，形态一致（高度、圆角、字号相同），颜色一个是金色一个是青蓝，肉眼可明显区分，不重叠。
3. 点击「去赛事平台↗」在当前标签不跳转，在新标签打开 https://tour.whleague.win，且页面正常加载。
4. 点击「🏅鸣谢」弹出居中弹层（半透明遮罩 + 卡片），连续点击多次语录会变化且不会连续出现同一条；按 Escape、点遮罩空白处、点右上角 ✕ 都能关闭。
5. 未登录状态下两个按钮都可见可用。
6. 375px 窄屏下顶栏不出现横向滚动条，两个按钮不溢出（允许换行）。
7. 用浏览器实际操作验证以上每一条，把实测结果（按钮的 href/target/rel、两个按钮的颜色与位置、"新标签打开" 的结果）写进交付说明。

## 不做的事
- 不改登录、注册、会话、cookie 相关代码。
- 不做跨站数据传递（不需要带参数给赛事平台）。
- 不加第二个跳转入口（不在页面别处再放赛事平台链接）。
- 不重构现有顶栏结构，只在导航链里插入这两项。

## 完成后请交给我
- 改了哪些文件、每个文件做了什么。
- 自动化命令的输出结果（typecheck/build）。
- 浏览器实测的关键证据（上面验收标准里列的那几项）。
- 若竞猜站侧已有自己的鸣谢或外链入口导致位置/配色需要调整，先说明现状再改，不要静默替换。
````

## 待你拍板的两处（prompt 里已按下面取值写好，要改我改完重发）

1. 跳转按钮文案：现取「去赛事平台↗」，与赛事平台那侧「去竞猜站↗」对称。备选「去赛事系统↗」。
2. 语录是否适配：现取「12 条照抄 + 把『战术板/4-2-4/球员』等赛事专有词换成竞猜语境说法」。备选「原样照抄不换词」——最省事，但竞猜站弹层里会出现「战术板」字样。

## 参考实现的来源（本仓，便于日后核对与复用）

- `src/components/Credits.tsx`：鸣谢按钮 + 弹层组件（12 条语录、`lastQuote` 防连重、Escape 关闭、遮罩点击关闭）。
- `src/components/TopBar.tsx`：顶栏导航链顺序——战术板 → admin 链接 → 我的球队 → `CreditsButton`（第43行）→ 竞猜外链（第44-48行，class `btn-guess`），两项均由 `!forced` 门控。
- `src/lib/links.ts`：`GUESS_URL = "https://guess.whleague.win"` 常量落点，竞猜侧对应写 `TOUR_URL`。
- `src/styles.css`：`.btn-credit` 与 `.credit` 系列在 `:1822` 起；`.nav-links a.btn-guess` 在 `.btn-credit:hover` 之后（复合选择器是为压过 `:177` 的 `.nav-links a` 标签选择器）。
