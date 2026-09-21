import { createRouter, createWebHashHistory } from "vue-router";
import { usePdfDocument } from "../composables/usePdfDocument";
import HomePage from "../views/HomePage.vue";
import EditorPage from "../views/EditorPage.vue";

// Hash 路由无需静态托管服务提供页面回退，兼容 GitHub Pages 的仓库子路径。
export const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", name: "home", component: HomePage },
    {
      path: "/editor",
      name: "editor",
      component: EditorPage,
      beforeEnter: () => (usePdfDocument().session.value ? true : { name: "home" }),
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
