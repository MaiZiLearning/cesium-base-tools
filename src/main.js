import { createApp } from "vue";
import * as Cesium from "cesium";
import App from "./App.vue";
import router from "./router/index.js";
import "./style.css";
import "cesium/Build/Cesium/Widgets/widgets.css";

window.Cesium = Cesium;

const ionAccessToken = import.meta.env.VITE_CESIUM_ION_ACCESS_TOKEN?.trim();

if (ionAccessToken) {
  Cesium.Ion.defaultAccessToken = ionAccessToken;
} else {
  console.warn(
    "未配置 VITE_CESIUM_ION_ACCESS_TOKEN，Cesium.Ion.defaultAccessToken 可能无法访问世界地形。",
  );
}

createApp(App).use(router).mount("#app");
