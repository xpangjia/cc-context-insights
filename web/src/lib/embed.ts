/** 被别的页面用 iframe 嵌入时隐藏自己的页头页脚,看起来像宿主页面的一部分 */
export const embedded = (() => { try { return window.self !== window.top; } catch { return true; } })();
