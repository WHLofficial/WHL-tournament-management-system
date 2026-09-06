// 淘汰赛轮次名：原为前端 MatchesTab 本地函数，#13 头版门户要在后端生成轮次文案（快讯/战报），
// 上移共享，前端原引用改为从这里导入。
export function elimRoundName(round: number, rounds: number): string {
  const slots = 2 ** (rounds - round);
  if (slots === 1) return "决赛";
  if (slots === 2) return "半决赛";
  if (slots === 4) return "1/4 决赛";
  return `1/${slots} 决赛`;
}
