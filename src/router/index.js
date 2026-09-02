import { createRouter, createWebHistory } from "vue-router";

const routes = [
  {
    path: "/",
    redirect: "/height-map",
  },
  {
    path: "/height-map",
    name: "HeightMap",
    component: () => import("../views/heightmap/HeightMap.vue"),
    meta: { title: "地形高度图", icon: "▧" },
  },
  {
    path: "/offscreen-height-map",
    name: "OffscreenHeightMap",
    component: () => import("../views/offscreen-heightmap/OffscreenHeightMap.vue"),
    meta: { title: "离屏渲染高度图", icon: "▧" },
  },
];

export default createRouter({
  history: createWebHistory(),
  routes,
});