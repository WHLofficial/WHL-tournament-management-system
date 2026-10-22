# 重新生成标题宋体子集（plan-v5.8.1 §F1）：Noto Serif SC 600 → public/fonts/*.woff2
#
# 字符集口径：src / worker / shared 的源码全文 + index.html + 生产 20 支球队名
# + Latin-1/Latin-Ext-A + 常用标点。源码注释里的字也会带进来（tests、migrations 不扫）
# ——字符集宁宽勿窄，标题掉字比多 20KB 难看。
#
# 依赖：pip install fonttools brotli
# 用法：python scripts/build-fonts.py
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public/fonts/noto-serif-sc-600-subset.woff2"
CACHE = ROOT / "scripts/.font-cache/NotoSerifSC_600SemiBold.ttf"
TTF_URL = (
    "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-serif-sc@0.4.4"
    "/600SemiBold/NotoSerifSC_600SemiBold.ttf"
)

# 生产库在线的球队名（本地 D1 只有测试数据，不能只靠扫本地数据取字）
CLUB_NAMES = [
    "AC米兰(CPU)", "RB莱比锡", "佛罗伦萨", "切尔西", "利物浦", "奥林匹亚科斯",
    "尤文图斯", "巴塞罗那", "巴黎圣日耳曼", "慕尼黑1860", "拜仁慕尼黑", "曼城(CPU)",
    "曼联", "皇家贝蒂斯", "皇家马德里", "纽卡斯尔联", "诺丁汉森林", "里昂",
    "阿斯顿维拉", "阿森纳",
]

SCAN = (
    "src/**/*.ts",
    "src/**/*.tsx",
    "src/**/*.css",
    "worker/**/*.ts",
    "shared/**/*.ts",
    "index.html",
)


def collect_chars() -> str:
    chars = set()
    for pattern in SCAN:
        for path in ROOT.glob(pattern):
            chars.update(path.read_text(encoding="utf-8"))
    chars.update("".join(CLUB_NAMES))
    # ASCII + Latin-1 + Latin Extended-A：英文名、重音字母（Ø/Š/Đ/Ł）都会出现在标题里
    chars.update(chr(c) for c in range(0x20, 0x250))
    # 中文标点与界面符号（emoji 会被 pyftsubset 跳过，不影响）
    chars.update("·—–…“”‘’「」『』【】《》〈〉、。，；：？！（）％‰×÷±≤≥≠→←↑↓★☆")
    return "".join(sorted(c for c in chars if c.isprintable()))


def main() -> int:
    if not CACHE.exists():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        print(f"下载 {TTF_URL}")
        urllib.request.urlretrieve(TTF_URL, CACHE)
    chars = collect_chars()
    chars_file = CACHE.with_name("chars.txt")
    chars_file.write_text(chars, encoding="utf-8")
    cjk = sum(1 for c in chars if "\u4e00" <= c <= "\u9fff")
    print(f"字符集 {len(chars)} 字（CJK {cjk}）→ {chars_file}")

    cmd = [
        sys.executable, "-m", "fontTools.subset", str(CACHE),
        f"--text-file={chars_file}",
        f"--output-file={OUT}",
        "--flavor=woff2",
        # 只留排版必需的四个特性；vert/vrt2 等竖排特性用不到
        "--layout-features=kern,liga,locl,ccmp",
        "--glyph-names", "--symbol-cmap", "--legacy-cmap",
        "--notdef-glyph", "--notdef-outline", "--recommended-glyphs",
    ]
    subprocess.run(cmd, check=True)
    print(f"写出 {OUT.relative_to(ROOT)}（{OUT.stat().st_size:,} B）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
