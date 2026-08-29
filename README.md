# Cesium 地形高度图示例

这是一个干净、可独立运行的 Cesium 高度图示例程序，使用 Vue 3、Vite 和 Tweakpane 构建。

当前仓库只保留 `src/views/heightmap` 示例。项目仍保留多实例路由和导航结构，后续新增开源功能时，可以按同样的方式添加新的 view、路由和导航元数据。

## 快速开始

```bash
npm install
npm run dev
```

地形服务需要 Cesium Ion access token。复制 `.env.example` 为 `.env.local`，填入自己的 token：

```bash
VITE_CESIUM_ION_ACCESS_TOKEN=your-cesium-ion-access-token
```

打开 <http://127.0.0.1:5173/>，或直接访问 <http://127.0.0.1:5173/height-map>。

生产构建：

```bash
npm run build
npm run preview
```

## 项目结构

```text
src/
├── App.vue                         # 应用布局和示例导航
├── main.js                         # Vue 与 Cesium 入口
├── router/index.js                 # 多实例路由
├── config/examples.js              # 导航元数据
└── views/
    └── heightmap/
        ├── HeightMap.vue           # 高度图示例页面
        ├── js/HeightMapMapWorks.js # Viewer 与交互控制
        └── lib/
            ├── HeightMapGenerator.js
            └── HeightMapVisualizer.js
```

## 添加新的示例

1. 在 `src/views/<example-name>/` 创建页面和功能代码。
2. 在 `src/router/index.js` 增加路由。
3. 在 `src/config/examples.js` 增加导航元数据。

示例内部的 Cesium 逻辑建议放在自己的 `js/` 或 `lib/` 目录中，避免不同示例之间产生隐式依赖。

## 说明

Cesium 的运行时资源由 `vite-plugin-cesium` 在开发和构建过程中处理。应用会将 `VITE_CESIUM_ION_ACCESS_TOKEN` 设置到 `Cesium.Ion.defaultAccessToken`。如果出现“地形加载失败”提示，请检查 token 是否有效、是否有访问 Cesium World Terrain 的权限，以及当前网络连接。
