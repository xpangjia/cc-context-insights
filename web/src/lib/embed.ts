import type { Router } from "vue-router";

/** 被别的页面用 iframe 嵌入时隐藏自己的页头页脚,看起来像宿主页面的一部分 */
export const embedded = (() => { try { return window.self !== window.top; } catch { return true; } })();

/**
 * 嵌入时把内容高度告诉宿主,宿主把 iframe 撑到这么高,整页只有一个滚动条;
 * 在里面换页时通知宿主滚回 iframe 顶部。消息格式:{ source: "cc-context-insights", type: "height" | "nav", h? }
 */
export function startEmbedBridge(router: Router) {
  if (!embedded) return;
  const post = (msg: object) => window.parent.postMessage({ source: "cc-context-insights", ...msg }, "*");
  const root = document.getElementById("app")!;
  let last = 0;
  new ResizeObserver(() => {
    const h = Math.ceil(root.getBoundingClientRect().height);
    if (h !== last) { last = h; post({ type: "height", h }); }
  }).observe(root);
  router.afterEach((to, from) => { if (from.matched.length && to.path !== from.path) post({ type: "nav" }); });
}
