import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import { startEmbedBridge } from "./lib/embed";
import "./styles/tokens.css";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: () => import("./pages/Insights.vue") },
    { path: "/session", component: () => import("./pages/Session.vue") },
    { path: "/:rest(.*)*", redirect: "/" },
  ],
  scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
});
createApp(App).use(router).mount("#app");
startEmbedBridge(router);
