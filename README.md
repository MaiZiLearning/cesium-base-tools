# cesium-base-tools

`cesium-base-tools` 是一个基于 Vue 3、Vite 和 Cesium 构建的开源 WebGIS 示例与工具集合，持续整理 Cesium 场景能力、数据处理方式和可复用的底层工具。

当前版本包含两个可独立运行的高度图示例：一个用于演示 Cesium World Terrain 的地形高度图，另一个用于演示地形与 3D Tiles 合成表面的离屏高度图。示例提供高度图预览、采样点标注和参数调节面板，适合用于学习 Cesium 地形数据处理、3D Tiles 场景渲染、WebGL 纹理处理以及 Vue 组件集成。

> 项目目前处于持续整理和扩展阶段，后续会逐步加入更多独立的 Cesium 示例和工具。

## 项目内容

项目中的每个示例都以独立页面的形式组织，并通过统一的路由和侧边栏导航访问。示例会尽量保持自身的状态、地图逻辑和工具代码独立，便于单独学习、调试和扩展。

当前已收录的示例如下。

### 地形高度图

访问 `/height-map` 查看基础地形高度图示例，当前支持：

- 从 Cesium World Terrain 加载真实地形数据
- 在 `256 x 256`、`512 x 512` 和 `1024 x 1024` 三种分辨率之间切换
- 通过 GPU 离屏渲染生成归一化高度纹理
- 将生成的高度图叠加到对应地形区域
- 显示高度图灰度预览
- 标注区域中心、西南角和东北角的采样高度
- 调整图层显隐和透明度，并快速定位到目标区域
- 使用 Tweakpane 查看生成状态、纹理尺寸和实际高度范围

### 离屏渲染高度图

访问 `/offscreen-height-map` 查看地形与 3D Tiles 合成高度图示例，当前支持：

- 加载 Cesium World Terrain 和公开 3D Tiles 模型
- 根据 3D Tiles 的 `boundingSphere` 自动计算高度图覆盖范围
- 使用 Cesium Picking 离屏渲染获取地形、3D Tiles 等可见几何的合成深度
- 手动触发高度图生成，不会在 3D Tiles 初始化时自动生成
- 将含有建筑物高度信息的灰度图贴回模型所在区域
- 显示高度图预览、中心/边界采样点和模型测试点高度
- 可选显示离屏正交相机，辅助检查相机覆盖范围
- 切换 3D Tiles 显隐，重新生成高度图以对比模型和纯地形结果

## 技术栈

- [Vue 3](https://vuejs.org/)：应用界面和组件开发
- [Vite](https://vite.dev/)：开发服务器和生产构建
- [CesiumJS](https://cesium.com/platform/cesiumjs/)：三维地球、地形数据和场景渲染
- [Tweakpane](https://tweakpane.github.io/docs/)：示例参数控制面板
- [vite-plugin-cesium](https://github.com/nshen/vite-plugin-cesium)：Cesium 运行时资源处理

## 环境要求

- Node.js `20.19+` 或 `22.12+`
- npm `10+`
- 可访问 Cesium Ion 的网络环境
- 一个具有 Cesium World Terrain 访问权限的 Cesium Ion access token

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 Cesium Ion Token

在 [Cesium Ion](https://ion.cesium.com/) 创建 access token，然后复制环境变量模板：

```bash
cp .env.example .env.local
```

在 `.env.local` 中填写 token：

```dotenv
VITE_CESIUM_ION_ACCESS_TOKEN=your-cesium-ion-access-token
```

Windows PowerShell 可以使用：

```powershell
Copy-Item .env.example .env.local
```

`.env.local` 仅用于本地开发，不要提交包含真实 token 的环境文件。仓库已通过 `.gitignore` 忽略本地环境配置。

### 3. 启动开发服务器

```bash
npm run dev
```

打开 <http://127.0.0.1:5173/>，应用会自动跳转到当前示例；也可以直接访问 <http://127.0.0.1:5173/height-map> 或 <http://127.0.0.1:5173/offscreen-height-map>。

### 4. 构建和预览生产版本

```bash
npm run build
npm run preview
```

## npm scripts

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm run build` | 构建生产版本到 `dist/` |
| `npm run preview` | 本地预览生产构建结果 |

## 项目结构

```text
.
├── index.html
├── package.json
├── vite.config.js
├── .env.example
└── src/
    ├── App.vue                         # 应用布局和示例导航
    ├── main.js                         # Vue 与 Cesium 入口
    ├── style.css                       # 全局样式
    ├── config/
    │   └── examples.js                 # 示例导航元数据
    ├── router/
    │   └── index.js                    # 示例路由
    ├── lib/
    │   ├── heightmap/
    │   │   ├── HeightMapGenerator.js
    │   │   └── HeightMapVisualizer.js  # 两个高度图示例共用
    │   └── offscreen-heightmap/
    │       └── OffscreenHeightMapGenerator.js
    └── views/
        ├── heightmap/
        │   ├── HeightMap.vue           # 地形高度图示例页面
        │   └── js/
        │       └── HeightMapMapWorks.js # Viewer 生命周期和交互控制
        └── offscreen-heightmap/
            ├── OffscreenHeightMap.vue  # 离屏高度图示例页面
            └── js/
                └── OffscreenHeightMapMapWorks.js
```

## 添加新的示例

每个示例应尽量保持独立，推荐按以下步骤添加：

1. 在 `src/views/<example-name>/` 下创建页面和示例专属的状态、交互逻辑。
2. 在 `src/router/index.js` 中注册路由。
3. 在 `src/config/examples.js` 中添加导航元数据。
4. 将地图初始化、事件协调和示例流程放在对应示例的 `js/` 目录中；可复用或较复杂的算法、渲染实现放在 `src/lib/<feature>/` 中。
5. 在本地运行 `npm run build`，确认生产构建正常完成。

示例可以参考 `src/views/heightmap/` 和 `src/views/offscreen-heightmap/` 的组织方式。页面组件负责生命周期管理，示例的地图编排逻辑集中在 `js/` 中，公共算法和渲染实现集中在 `src/lib/` 中。多个示例需要使用同一功能时，应直接复用公共实现，避免在示例目录中维护重复文件。

## Cesium Token 和地形加载

当前的地形高度图示例会读取 `VITE_CESIUM_ION_ACCESS_TOKEN`，并将其设置为 `Cesium.Ion.defaultAccessToken`。没有配置 token 时，应用页面仍可启动，但 Cesium World Terrain 可能无法加载，高度图也无法生成。后续新增的示例是否需要 Cesium Ion 服务，将在各自的示例说明中注明。

如果看到地形加载失败或高度图生成失败，请依次检查：

1. `.env.local` 是否位于项目根目录。
2. 环境变量名称是否为 `VITE_CESIUM_ION_ACCESS_TOKEN`。
3. token 是否有效且没有过期或被撤销。
4. token 是否具有访问 Cesium World Terrain 的权限。
5. 当前网络是否可以访问 Cesium Ion 服务。

修改 `.env.local` 后需要重启开发服务器，Vite 才会重新读取环境变量。

## 贡献

欢迎提交 Issue 和 Pull Request。提交新示例或修复时，建议：

- 保持示例之间的代码和状态相互独立
- 优先复用现有的 Vue、Cesium 和 Vite 配置
- 为新增的交互或配置补充必要的说明
- 提交前运行 `npm run build`
- 不要提交 `.env.local`、Cesium Ion token 或其他敏感信息

## 许可证

本仓库当前尚未附带正式的 `LICENSE` 文件。发布或再分发前，请先补充项目许可证，并确认 CesiumJS、Cesium Ion 服务及其他依赖的许可和使用条款。
