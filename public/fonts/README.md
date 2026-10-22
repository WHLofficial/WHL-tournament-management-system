# 字体文件（tour，v5.8.1）

三族全部 OFL 授权、自托管；构建时 Vite 原样拷到 `dist/fonts/`（`public/` 是默认 publicDir）。

| 文件 | 字节 | 来源 | 用途 |
| --- | --- | --- | --- |
| `noto-serif-sc-600-subset.woff2` | 276,784 | Noto Serif SC 600（@expo-google-fonts/noto-serif-sc 0.4.4）→ 本仓字符集子集 | 版面标题（`h1` / `.art-title` / `.page-head h2` / `.whl-masthead h2`） |
| `inter-latin.woff2` | 48,444 | @fontsource-variable/inter 5.2.5，wght 100–900 | 正文西文（latin 片，首屏 preload） |
| `inter-latin-ext.woff2` | 74,328 | 同上 | 正文西文重音字符（š/đ/ł 等，按 unicode-range 懒加载） |
| `jbmono-latin.woff2` | 40,404 | @fontsource-variable/jetbrains-mono 5.2.5，wght 100–800 | 数字（比分/统计/时间码） |
| `jbmono-latin-ext.woff2` | 15,196 | 同上 | 数字层的重音字符（少见） |

`OFL-*.txt` 是对应上游许可证原文，随字体一起分发。

## 再生成宋体子集

字符集口径：`src` / `worker` / `shared` 源码全文 + `index.html` + 生产 20 支球队名 + `0x20–0x24F`
+ 常用中文标点（`tests`、`migrations` 不扫）。源码注释里的字也会带进来——宁宽勿窄，
标题掉字比多 20KB 难看。

```bash
pip install fonttools brotli
python scripts/build-fonts.py
```

脚本把上游 TTF 缓存到 `scripts/.font-cache/`（已 gitignore）。改版后请更新本表字节数与
`memory/plan-v5.8.1-font-scheme.md` 的数字。

## 两条硬约束

1. 宋体子集只有 **600** 一档：标题规则必须带 `font-synthesis-weight: none`，否则写 700 会被浏览器
   合成假粗（中文会糊）。
2. 子集外的字（生僻人名、罕见标点）会逐字回退到系统宋体（`Songti SC` / `SimSun`）——可见的粗细
   差异，属于可接受降级；若某字长期出现在标题里，把它补进脚本字符集后重跑。
