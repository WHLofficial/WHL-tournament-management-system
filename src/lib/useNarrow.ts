import { useEffect, useState } from "react";

/**
 * 视口是不是「窄屏」（默认 979px，跟战术页窄屏版面同一条线）。
 * 用途：队长与定位球的槽位 chip 在桌面深链进编排页、窄屏开底部弹层；
 * 编排页的半场板也只在桌面宽度渲染，手机落到分组槽位列表。
 * jsdom 没有 matchMedia（测试环境）时恒为 false，即按桌面口径走。
 */
export function useNarrow(maxWidth = 979): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState<boolean>(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

function matches(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}
