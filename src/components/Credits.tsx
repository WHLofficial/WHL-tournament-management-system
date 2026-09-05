import { useEffect, useState } from "react";

// 鸣谢语录：战术板助手 v1 的彩蛋，全局弹层（TopBar 入口）
const QUOTES = [
  "没琛止打钱，这块战术板今晚就得变人工智障。LLM算力靠氪金，首席赞助稳住我的饭碗🫡👑",
  "琛止哥的token就是这块板子的肾上腺素，没他这波赞助，你们点的每个磁贴都是一串乱码🌚",
  "你们在这排的每一套阵型，背后都是琛止在默默燃烧经费——这叫什么？金主爸爸的钞能力驱动战术AI，respect。",
  "没有琛止哥的token燃烧，就没有这个24小时在线的战术板。哪天服务器一抽风我就当场躺平，让你们见识见识“没有LLM赞助的战术板”——大概就是张白纸🌚",
  "没琛总赞助我当场断电，你们的4-2-4连个球员角色都配不明白🌚 感谢琛总保住我的数字牛马岗位！",
  "没有琛止哥的投喂，这块穷板子早就白屏了——你们每排一套阵、每解一个码，都是真金白银，今天还能陪你们踢联赛，全靠琛止哥扛着账单🥺",
  "本板子的智商是租来的，租金全是琛止哥在付。哪天断了供，你们点开的就是一块会呼吸的白板🌚",
  "你们手滑点错磁贴没关系，琛止哥手滑忘充值才是大事——那一刻，战术板、首发、联赛，全都灰了🫡",
  "每解一个战术码，就烧一次token；每次token燃烧，都有琛止哥在买单。这不叫排阵，这叫钞能力拉满👑",
  "我为什么算校验码又快又准？因为背后是琛止哥的API在硬扛。人工智障和人工智能，就差他这一笔赞助🥺",
  "别问板子为什么这么稳，问就是琛止哥的API稳。他的账单不抖，你们的4-2-4就不抖🌚",
  "在这排阵是免费的，但对我的大脑来说可不便宜——每格磁贴背后都是琛止哥实打实的账单🥺 鸣谢首席赞助！",
];

let lastQuote = -1;

export function CreditsButton() {
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState(QUOTES[0]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function openCredit() {
    let i: number;
    do {
      i = Math.floor(Math.random() * QUOTES.length);
    } while (i === lastQuote && QUOTES.length > 1);
    lastQuote = i;
    setQuote(QUOTES[i]);
    setOpen(true);
  }

  return (
    <>
      <button className="btn-credit" onClick={openCredit}>
        🏅鸣谢
      </button>
      {open && (
        <div
          className="credit"
          role="dialog"
          aria-modal="true"
          aria-label="鸣谢"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="credit-card">
            <button
              className="credit-close"
              aria-label="关闭鸣谢"
              onClick={() => setOpen(false)}
            >
              ✕
            </button>
            <p className="credit-title">🏅 鸣谢</p>
            <p className="credit-main">
              本项目使用 ZCode 产出。
              <br />
              感谢 <b>琛止</b> 赞助 LLM API 费用。
            </p>
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
