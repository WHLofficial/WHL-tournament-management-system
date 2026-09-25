// 版本号由 vite define 注入（单一真源 = package.json 的 version，口径见 VERSIONS.md）
declare const __APP_VERSION__: string;

export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
