/**
 * OffscreenHeightMapMapWorks.js — Cesium 离屏渲染高度图地图操作封装
 * ---------------------------------------------------------------------------
 * 离屏高度图示例的地图操作模块：
 * - 模块级变量存储 Viewer、生成器和可视化器状态
 * - 使用 Tweakpane 构建示例控制面板
 * - 导出 initMap / destroy 供 Vue 组件调用
 * - 加载公开 3DTiles，并将地形与模型合成为高度图
 */
import { Pane } from "tweakpane";
import OffscreenHeightMapGenerator from "@/lib/offscreen-heightmap/OffscreenHeightMapGenerator.js";
import HeightMapVisualizer from "@/lib/heightmap/HeightMapVisualizer.js";

const SCGIS_TILESET_URL =
  "https://www.scgis.net/services/longchang_3dtiles/file/tileset.json?ak=623d2c5223vxqc44b2cd3832989bfc21";
const MODEL_TEST_POINT = {
  longitude: Cesium.Math.toRadians(105.264784),
  latitude: Cesium.Math.toRadians(29.354826),
};

const params = {
  textureSize: 512,
  alpha: 0.7,
  show: true,
  showTileset: true,
  showOffscreenCamera: false,
  status: "等待地形瓦片加载",
  size: "-",
  heightRange: "-",
};

let viewer = null;
let generator = null;
let visualizer = null;
let previewCanvas = null;
let statusElement = null;
let pane = null;
let guiGeneration = 0;
let taskGeneration = 0;
let generateTimer = null;
let sampleTimer = null;
let offscreenCameraPrimitive = null;

let scgisTileset = null;
let scgisBoundingSphere = null;
let tilesetRectangle = null;
let tilesetsReady = false;
let tilesetsReadyPromise = null;
let tilesetLoadGeneration = 0;
let regionEntity = null;

function clearTimer(timer) {
  if (timer !== null) window.clearTimeout(timer);
  return null;
}

function removeOffscreenCameraDebug() {
  if (!offscreenCameraPrimitive || !viewer || viewer.isDestroyed()) {
    offscreenCameraPrimitive = null;
    return;
  }
  try {
    viewer.scene.primitives.removeAndDestroy(offscreenCameraPrimitive);
  } catch (_) {}
  offscreenCameraPrimitive = null;
}

function updateOffscreenCameraDebug() {
  removeOffscreenCameraDebug();
  if (
    !params.showOffscreenCamera ||
    !viewer ||
    viewer.isDestroyed() ||
    !generator
  ) {
    return;
  }
  const camera = generator.getOffscreenCamera?.();
  if (!camera) return;
  offscreenCameraPrimitive = viewer.scene.primitives.add(
    new Cesium.DebugCameraPrimitive({
      camera,
      color: Cesium.Color.YELLOW,
      updateOnChange: false,
      show: true,
    }),
  );
}

function flyToBoundingSphere(boundingSphere) {
  return new Promise((resolve, reject) => {
    if (!viewer || viewer.isDestroyed() || !boundingSphere) {
      reject(new Error("3DTiles 模型或 Viewer 不可用"));
      return;
    }

    try {
      viewer.camera.cancelFlight();
      viewer.camera.flyToBoundingSphere(boundingSphere, {
        duration: 1.2,
        offset: new Cesium.HeadingPitchRange(
          0,
          Cesium.Math.toRadians(-35),
          Math.max(boundingSphere.radius * 2.8, 1500),
        ),
        complete: resolve,
        cancel: () => reject(new Error("定位 3DTiles 模型被取消")),
      });
    } catch (error) {
      reject(error);
    }
  });
}

function flyToRegion(boundingSphere, generation) {
  return new Promise((resolve) => {
    if (
      !viewer ||
      viewer.isDestroyed() ||
      !boundingSphere ||
      generation !== taskGeneration
    ) {
      resolve(false);
      return;
    }

    flyToBoundingSphere(boundingSphere)
      .then(() => resolve(generation === taskGeneration))
      .catch((error) => {
        if (generation === taskGeneration) {
          console.error("定位 3DTiles 模型失败", error);
        }
        resolve(false);
      });
  });
}

function setStatus(text, tone = "info") {
  if (!statusElement) return;
  statusElement.className = `heightmap-status ${tone}`;
  statusElement.textContent = text;
  params.status = text;
  refreshPane();
}

function refreshPane(expectedGeneration = guiGeneration) {
  if (!pane || expectedGeneration !== guiGeneration) return;
  try {
    pane.refresh();
  } catch (error) {
    if (error?.name !== "DeveloperError") throw error;
  }
}

function createRegionData(rectangle) {
  const positions = Cesium.Cartesian3.fromRadiansArray([
    rectangle.west,
    rectangle.south,
    rectangle.east,
    rectangle.south,
    rectangle.east,
    rectangle.north,
    rectangle.west,
    rectangle.north,
  ]);
  return { positions, rectangle };
}

function addRegionEntity(regionData) {
  regionEntity = viewer.entities.add({
    name: "3DTiles 高度图范围",
    polygon: {
      hierarchy: new Cesium.PolygonHierarchy(regionData.positions),
      material: Cesium.Color.fromCssColorString("#4ea1ff").withAlpha(0.28),
    },
  });
  return regionEntity;
}

function createPreview(heightMapData) {
  if (!previewCanvas) return;

  previewCanvas.width = heightMapData.width;
  previewCanvas.height = heightMapData.height;
  previewCanvas.hidden = false;
  const context = previewCanvas.getContext("2d");
  const imageData = context.createImageData(
    previewCanvas.width,
    previewCanvas.height,
  );

  for (let y = 0; y < heightMapData.height; y++) {
    const sourceY = heightMapData.height - 1 - y;
    for (let x = 0; x < heightMapData.width; x++) {
      const sourceIndex = (sourceY * heightMapData.width + x) * 4;
      const gray = Math.max(
        0,
        Math.min(255, heightMapData.data[sourceIndex] * 255),
      );
      const targetIndex = (y * heightMapData.width + x) * 4;
      imageData.data[targetIndex] = gray;
      imageData.data[targetIndex + 1] = gray;
      imageData.data[targetIndex + 2] = gray;
      imageData.data[targetIndex + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
}

function clearPreview() {
  if (!previewCanvas) return;
  previewCanvas.hidden = true;
  previewCanvas.getContext("2d")?.clearRect(
    0,
    0,
    previewCanvas.width,
    previewCanvas.height,
  );
}

function addSamplePoints(rectangle, generation) {
  sampleTimer = clearTimer(sampleTimer);
  sampleTimer = window.setTimeout(() => {
    if (!viewer || generation !== taskGeneration || !generator) return;

    const points = [
      {
        name: "中心",
        lon: (rectangle.west + rectangle.east) / 2,
        lat: (rectangle.south + rectangle.north) / 2,
        color: Cesium.Color.RED,
      },
      {
        name: "西南",
        lon: rectangle.west,
        lat: rectangle.south,
        color: Cesium.Color.LIME,
      },
      {
        name: "东北",
        lon: rectangle.east,
        lat: rectangle.north,
        color: Cesium.Color.CYAN,
      },
      {
        name: "测试点",
        lon: MODEL_TEST_POINT.longitude,
        lat: MODEL_TEST_POINT.latitude,
        color: Cesium.Color.GREEN,
      },
    ];

    points.forEach((point) => {
      const height = generator.sampleHeight(point.lon, point.lat);
      if (height === null) return;
      const position = Cesium.Cartesian3.fromRadians(point.lon, point.lat, height);
      viewer.entities.add({
        name: `采样点 ${point.name}`,
        position,
        point: {
          pixelSize: 10,
          color: point.color,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
        },
        label: {
          text: `${point.name}  ${height.toFixed(1)} m`,
          font: "12px sans-serif",
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -14),
        },
      });
    });
  }, 300);
}

/* ===================== 3DTiles 演示 ===================== */

function load3DTiles() {
  if (!viewer || viewer.isDestroyed()) return null;
  if (tilesetsReadyPromise) return tilesetsReadyPromise;

  const loadGeneration = ++tilesetLoadGeneration;
  tilesetsReady = false;
  tilesetRectangle = null;
  let loadedTileset = null;
  const requestPromise = (async () => {
    // 互联网开源 3DTiles：四川泸州科创园区公开服务（无需 Token，CORS OK）
    const loadTileset = async (url) => {
      if (typeof Cesium.Cesium3DTileset.fromUrl === "function") {
        return await Cesium.Cesium3DTileset.fromUrl(url);
      }
      return new Cesium.Cesium3DTileset({ url });
    };

    loadedTileset = await loadTileset(SCGIS_TILESET_URL);
    if (!viewer || viewer.isDestroyed() || loadGeneration !== tilesetLoadGeneration) {
      try { loadedTileset.destroy(); } catch (_) {}
      throw new Error("3DTiles 加载任务已取消");
    }

    scgisTileset = loadedTileset;
    viewer.scene.primitives.add(loadedTileset);
    loadedTileset.show = params.showTileset;
    if (loadedTileset.readyPromise) {
      await loadedTileset.readyPromise;
    }
    if (!viewer || viewer.isDestroyed() || loadGeneration !== tilesetLoadGeneration) {
      throw new Error("3DTiles 加载任务已取消");
    }

    scgisBoundingSphere = loadedTileset.boundingSphere;

    const boundingSphere = loadedTileset.boundingSphere;
    if (
      !boundingSphere?.center ||
      !Number.isFinite(boundingSphere.radius) ||
      boundingSphere.radius <= 0
    ) {
      throw new Error("3DTiles 未提供有效的包围球，无法确定高度图范围");
    }

    const rectangle = Cesium.Rectangle.fromBoundingSphere(
      boundingSphere,
      Cesium.Ellipsoid.WGS84,
    );
    if (
      !rectangle ||
      ![rectangle.west, rectangle.south, rectangle.east, rectangle.north].every(
        (value) => Number.isFinite(value),
      ) ||
      rectangle.east <= rectangle.west ||
      rectangle.north <= rectangle.south
    ) {
      throw new Error("无法从 3DTiles 包围球计算有效的高度图范围");
    }

    tilesetRectangle = rectangle;
    generator?.setTileset?.(loadedTileset);
    await flyToBoundingSphere(scgisBoundingSphere);
    if (!viewer || viewer.isDestroyed()) {
      throw new Error("Viewer 在 3DTiles 定位前已销毁");
    }
    viewer.scene.requestRender();
    updateOffscreenCameraDebug();
    tilesetsReady = true;
    console.log(
      "[3DTiles] 公开 Tileset 已加载，正在请求可见瓦片",
      SCGIS_TILESET_URL,
    );
    refreshPane();
    return rectangle;
  })();

  tilesetsReadyPromise = requestPromise.catch((error) => {
    console.error("[3DTiles] 公开 Tileset 加载失败", error);
    if (loadedTileset && viewer && !viewer.isDestroyed()) {
      try { viewer.scene.primitives.remove(loadedTileset); } catch (_) {}
      try { loadedTileset.destroy(); } catch (_) {}
    }
    if (scgisTileset === loadedTileset) scgisTileset = null;
    tilesetRectangle = null;
    tilesetsReady = false;
    tilesetsReadyPromise = null;
    throw error;
  });

  return tilesetsReadyPromise;
}

function setTilesetVisible(visible) {
  if (scgisTileset) scgisTileset.show = visible;
  generator?.setTileset?.(scgisTileset);
  if (viewer) viewer.scene.requestRender();
}

function remove3DTiles() {
  ++tilesetLoadGeneration;
  if (regionEntity && viewer && !viewer.isDestroyed()) {
    viewer.entities.remove(regionEntity);
  }
  regionEntity = null;

  if (scgisTileset && viewer && !viewer.isDestroyed()) {
    try { viewer.scene.primitives.removeAndDestroy(scgisTileset); } catch (_) {}
  }
  scgisTileset = null;
  scgisBoundingSphere = null;
  tilesetRectangle = null;
  tilesetsReady = false;
  tilesetsReadyPromise = null;
}

function initGui(generate) {
  const generation = ++guiGeneration;
  pane = new Pane({
    title: "离屏渲染高度图控制",
    expanded: true,
  });

  const generationFolder = pane.addFolder({ title: "高度图生成" });
  generationFolder.addBinding(params, "textureSize", {
    label: "纹理分辨率",
    options: {
      "256 × 256": 256,
      "512 × 512": 512,
      "1024 × 1024": 1024,
    },
  }).on("change", () => {
    if (generation === guiGeneration) generate();
  });
  generationFolder.addButton({ title: "重新生成高度图" }).on("click", () => {
    if (generation === guiGeneration) generate();
  });

  const cameraFolder = pane.addFolder({ title: "离屏相机调试", expanded: false });
  cameraFolder.addBinding(params, "showOffscreenCamera", {
    label: "显示离屏相机",
  }).on("change", (event) => {
    if (generation !== guiGeneration) return;
    if (event.value) updateOffscreenCameraDebug();
    else removeOffscreenCameraDebug();
    viewer?.scene.requestRender();
  });

  const tilesetFolder = pane.addFolder({
    title: "3DTiles 合成表面",
    expanded: true,
  });
  tilesetFolder.addBinding(params, "showTileset", {
    label: "显示 3DTiles",
  }).on("change", (event) => {
    if (generation !== guiGeneration) return;
    setTilesetVisible(event.value);
    setStatus(
      event.value
        ? "已显示 3DTiles，重新生成可捕获建筑高度"
        : "已隐藏 3DTiles，重新生成为纯地形",
      "info",
    );
  });
  tilesetFolder.addButton({ title: "重新加载 3DTiles" }).on("click", async () => {
    if (generation !== guiGeneration) return;
    remove3DTiles();
    setStatus("正在重新加载 3DTiles...", "loading");
    try {
      await load3DTiles();
      setStatus("3DTiles 已定位，请点击“重新生成高度图”", "success");
    } catch (error) {
      setStatus(`3DTiles 加载失败：${error?.message || "请重试"}`, "error");
    }
  });

  const layerFolder = pane.addFolder({ title: "图层控制" });
  layerFolder.addBinding(params, "show", { label: "显示高度图" }).on("change", (event) => {
    if (generation !== guiGeneration || !visualizer) return;
    if (event.value) visualizer.showVisualization();
    else visualizer.hide();
  });
  layerFolder.addBinding(params, "alpha", {
    label: "透明度",
    min: 0,
    max: 1,
    step: 0.05,
  }).on("change", (event) => {
    if (generation !== guiGeneration) return;
    visualizer?.setAlpha(event.value);
  });
  layerFolder.addButton({ title: "定位图层" }).on("click", () => {
    if (generation === guiGeneration && scgisBoundingSphere) {
      flyToBoundingSphere(scgisBoundingSphere).catch(() => {});
    }
  });

  const statusFolder = pane.addFolder({ title: "生成状态" });
  statusFolder.addBinding(params, "status", { label: "状态", readonly: true });
  statusFolder.addBinding(params, "size", { label: "尺寸", readonly: true });
  statusFolder.addBinding(params, "heightRange", { label: "高度范围", readonly: true });

  const infoFolder = pane.addFolder({ title: "操作说明", expanded: false });
  infoFolder.element.querySelector(".tp-fldv_c").innerHTML = `
    <div style="padding: 8px; font-size: 11px; line-height: 1.6; color: #ccc;">
      <p>离屏渲染方式：使用正交相机 + Picking 系统渲染深度图，反投影还原世界坐标。</p>
      <p>支持地形 + 3DTiles + Primitive 等所有可见几何的合成表面。</p>
      <p><b>3DTiles 演示：</b>高度图范围自动取当前 3DTiles 包围球的地理范围；显示 3DTiles 时，灰度图可反映建筑物高度，隐藏后重新生成可对比纯地形结果。</p>
    </div>
  `;
}

function generateHeightMap() {
  const generation = ++taskGeneration;
  generateTimer = clearTimer(generateTimer);
  sampleTimer = clearTimer(sampleTimer);
  removeOffscreenCameraDebug();
  visualizer?.hide();
  if (regionEntity && viewer && !viewer.isDestroyed()) {
    viewer.entities.remove(regionEntity);
  }
  regionEntity = null;
  viewer.entities.removeAll();
  clearPreview();

  const rectangle = tilesetRectangle;
  if (!rectangle || !tilesetsReady || !generator || !visualizer) {
    setStatus("等待 3DTiles 范围就绪后生成高度图", "loading");
    return;
  }

  const regionData = createRegionData(rectangle);
  addRegionEntity(regionData);
  setStatus("正在定位到 3DTiles 模型..", "loading");
  params.size = "-";
  params.heightRange = "正在加载...";
  refreshPane();

  flyToRegion(scgisBoundingSphere, generation).then((regionLocated) => {
    if (
      !regionLocated ||
      !viewer ||
      viewer.isDestroyed() ||
      generation !== taskGeneration
    ) {
      return;
    }

    setStatus("等待 3DTiles/地形就绪后离屏渲染中..", "loading");
    generateTimer = window.setTimeout(async () => {
      if (!viewer || viewer.isDestroyed() || generation !== taskGeneration) return;
      try {
        generator.setTileset?.(scgisTileset);
        const texture = await generator.generate(rectangle, params.textureSize);
        if (generation !== taskGeneration) return;
        if (!texture) return;
        const data = generator.readHeightMapData();
        if (!data) return;
        createPreview(data);
        visualizer.show(rectangle, texture, {
          alpha: params.alpha,
          clampToGround: true,
        });
        if (!params.show) visualizer.hide();
        updateOffscreenCameraDebug();
        addSamplePoints(rectangle, generation);
        setStatus("高度图已生成（离屏渲染，含 3DTiles 建筑高度）", "success");
        params.size = `${data.width} × ${data.height}`;
        params.heightRange = `${data.minHeight.toFixed(1)} m - ${data.maxHeight.toFixed(1)} m`;
        refreshPane();
      } catch (error) {
        if (!viewer || viewer.isDestroyed() || generation !== taskGeneration) return;
        console.error("离屏渲染生成高度图失败", error);
        setStatus(
          "高度图生成失败，请检查 Cesium.Ion.defaultAccessToken 配置、网络连接或重试",
          "error",
        );
        params.heightRange = error?.message || "生成失败";
        refreshPane();
      }
    }, 700);
  });
}

export function initMap(container, elements) {
  if (viewer) destroy();
  const initializationGeneration = ++taskGeneration;
  previewCanvas = elements?.previewCanvas ?? null;
  statusElement = elements?.statusElement ?? null;
  viewer = new Cesium.Viewer(container, {
    animation: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    navigationHelpButton: false,
    scene3DOnly: true,
    contextOptions: { webgl: { alpha: true } },
  });

  viewer._cesiumWidget._creditContainer.style.display = "none";
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.globe.baseColor = new Cesium.Color(0, 0, 0, 0);
  viewer.scene.globe.enableLighting = true;
  initGui(generateHeightMap);
  setStatus("正在加载世界地形与 3DTiles...", "loading");

  Cesium.createWorldTerrainAsync({
    requestVertexNormals: true,
    requestWaterMask: true,
  })
    .then((terrainProvider) => {
      if (!viewer || viewer.isDestroyed() || initializationGeneration !== taskGeneration) {
        try { terrainProvider.destroy(); } catch (_) {}
        return;
      }

      viewer.terrainProvider = terrainProvider;
      generator = new OffscreenHeightMapGenerator(viewer, {
        debug: true,
        heightAbove: 5000,
        near: 0.1,
        far: 10000,
        waitForTerrain: false,
      });
      visualizer = new HeightMapVisualizer(viewer, generator);
      load3DTiles()
        .then(() => {
          if (initializationGeneration !== taskGeneration) return;
          setStatus("3DTiles 已定位，请点击“重新生成高度图”", "success");
        })
        .catch((error) => {
          if (!viewer || viewer.isDestroyed() || initializationGeneration !== taskGeneration) return;
          setStatus(`3DTiles 加载失败：${error?.message || "请重试"}`, "error");
          params.heightRange = error?.message || "3DTiles 加载失败";
          refreshPane();
        });
    })
    .catch((error) => {
      if (!viewer || viewer.isDestroyed() || initializationGeneration !== taskGeneration) {
        return;
      }
      console.error("世界地形初始化失败", error);
      setStatus(
        "地形加载失败，请检查 Cesium.Ion.defaultAccessToken 配置、网络连接或重试",
        "error",
      );
      params.heightRange = error?.message || "地形加载失败";
      refreshPane();
    });
}

export function destroy() {
  guiGeneration++;
  ++taskGeneration;
  generateTimer = clearTimer(generateTimer);
  sampleTimer = clearTimer(sampleTimer);
  removeOffscreenCameraDebug();
  if (viewer && !viewer.isDestroyed()) viewer.camera.cancelFlight();
  if (pane) {
    pane.dispose();
    pane = null;
  }
  visualizer?.destroy();
  generator?.destroy();
  remove3DTiles();
  clearPreview();
  if (viewer && !viewer.isDestroyed()) viewer.destroy();
  viewer = null;
  generator = null;
  visualizer = null;
  statusElement = null;
  previewCanvas = null;
}
