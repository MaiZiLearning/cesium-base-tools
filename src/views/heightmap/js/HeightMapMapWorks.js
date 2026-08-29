/**
 * HeightMapMapWorks.js — Cesium 地形高度图地图操作封装
 * ---------------------------------------------------------------------------
 * 高度图示例的地图操作模块：
 * - 模块级变量存储 viewer、生成器和可视化器状态
 * - 使用 Tweakpane 构建示例控制面板
 * - 导出 initMap / destroy 供 Vue 组件调用
 */
import { Pane } from "tweakpane";
import HeightMapGenerator from "../lib/HeightMapGenerator.js";
import HeightMapVisualizer from "../lib/HeightMapVisualizer.js";

const TEST_REGIONS = {
  mountains: [
    [110.91995822563997, 30.018123228872216, 966.02],
    [110.88602280929696, 30.02746264223286, 992.26],
    [110.87475288470748, 30.00061781074165, 673.74],
    [110.88525405115537, 29.97371359878412, 260.03],
    [110.89486388986987, 29.962314482553314, 639.59],
    [110.91982562243348, 29.973771216309125, 722.79],
    [110.92939046684434, 30.003520348332533, 1077.55],
  ],
  canyon: [
    [-112.15, 36.10, 2000],
    [-112.10, 36.10, 2000],
    [-112.10, 36.05, 2000],
    [-112.15, 36.05, 2000],
  ],
  himalaya: [
    [86.90, 27.95, 5000],
    [86.95, 27.95, 5000],
    [86.95, 27.90, 5000],
    [86.90, 27.90, 5000],
  ],
  plains: [
    [116.35, 39.95, 50],
    [116.45, 39.95, 50],
    [116.45, 39.85, 50],
    [116.35, 39.85, 50],
  ],
};

const params = {
  textureSize: 512,
  alpha: 0.7,
  region: "canyon",
  show: true,
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
let terrainTimer = null;
let generateTimer = null;
let flyToTimer = null;
let sampleTimer = null;

function clearTimer(timer) {
  if (timer !== null) window.clearTimeout(timer);
  return null;
}

function flyToRegion(rectangle, generation) {
  return new Promise((resolve) => {
    if (!viewer || viewer.isDestroyed() || generation !== taskGeneration) {
      resolve(false);
      return;
    }

    let completed = false;
    const finish = (result) => {
      if (completed) return;
      completed = true;
      resolve(result);
    };

    try {
      viewer.camera.cancelFlight();
      viewer.camera.flyTo({
        destination: rectangle,
        duration: 1.2,
        orientation: {
          heading: 0,
          pitch: Cesium.Math.toRadians(-55),
          roll: 0,
        },
        complete: () => finish(generation === taskGeneration),
        cancel: () => finish(false),
      });
    } catch (error) {
      console.error("定位高度图区域失败", error);
      finish(false);
    }
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

function createRegionData(region) {
  const positions = Cesium.Cartesian3.fromDegreesArrayHeights(region.flat());
  return {
    positions,
    rectangle: Cesium.Rectangle.fromCartesianArray(positions),
  };
}

function addRegionEntity(regionData) {
  return viewer.entities.add({
    polygon: {
      hierarchy: new Cesium.PolygonHierarchy(regionData.positions),
      material: Cesium.Color.fromCssColorString("#4ea1ff").withAlpha(0.28),
    },
  });
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

  for (let index = 0; index < heightMapData.data.length; index += 4) {
    const gray = Math.max(0, Math.min(255, heightMapData.data[index] * 255));
    imageData.data[index] = gray;
    imageData.data[index + 1] = gray;
    imageData.data[index + 2] = gray;
    imageData.data[index + 3] = 255;
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
      { name: "中心", lon: (rectangle.west + rectangle.east) / 2, lat: (rectangle.south + rectangle.north) / 2, color: Cesium.Color.RED },
      { name: "西南", lon: rectangle.west, lat: rectangle.south, color: Cesium.Color.LIME },
      { name: "东北", lon: rectangle.east, lat: rectangle.north, color: Cesium.Color.CYAN },
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

function initGui(generate) {
  const generation = ++guiGeneration;
  pane = new Pane({
    title: "地形高度图控制",
    expanded: true,
  });

  const generationFolder = pane.addFolder({ title: "高度图生成" });
  generationFolder.addBinding(params, "region", {
    label: "采样区域",
    options: {
      "美国大峡谷": "canyon",
      "中国山地": "mountains",
      "珠峰附近": "himalaya",
      "华北平原": "plains",
    },
  }).on("change", () => {
    if (generation === guiGeneration) generate();
  });
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

  const layerFolder = pane.addFolder({ title: "图层控制" });
  layerFolder.addBinding(params, "show", { label: "显示图层" }).on("change", (event) => {
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
    if (generation === guiGeneration) visualizer?.flyTo(1.5);
  });

  const statusFolder = pane.addFolder({ title: "生成状态" });
  statusFolder.addBinding(params, "status", { label: "状态", readonly: true });
  statusFolder.addBinding(params, "size", { label: "尺寸", readonly: true });
  statusFolder.addBinding(params, "heightRange", { label: "高度范围", readonly: true });

  const infoFolder = pane.addFolder({ title: "操作说明", expanded: false });
  infoFolder.element.querySelector(".tp-fldv_c").innerHTML = `
    <div style="padding: 8px; font-size: 11px; line-height: 1.6; color: #ccc;">
      <p>选择区域和分辨率后生成地形高度图。</p>
      <p>高度图会以贴地图层回显，并同步显示采样点高度。</p>
    </div>
  `;
}

function generateHeightMap() {
  const generation = ++taskGeneration;
  terrainTimer = clearTimer(terrainTimer);
  generateTimer = clearTimer(generateTimer);
  flyToTimer = clearTimer(flyToTimer);
  sampleTimer = clearTimer(sampleTimer);
  visualizer?.hide();
  viewer.entities.removeAll();
  clearPreview();
  const regionData = createRegionData(TEST_REGIONS[params.region]);
  addRegionEntity(regionData);
  setStatus("正在定位到目标区域...", "loading");
  params.size = "-";
  params.heightRange = "正在加载...";
  refreshPane();

  flyToRegion(regionData.rectangle, generation).then((regionLocated) => {
    if (
      !regionLocated ||
      !viewer ||
      viewer.isDestroyed() ||
      generation !== taskGeneration
    ) {
      return;
    }

    setStatus("正在等待目标区域地形瓦片...", "loading");
    let terrainLoadedChecks = 0;
    const waitForTerrain = () => {
      if (!viewer || viewer.isDestroyed() || generation !== taskGeneration) return;

      if (!generator || !viewer.scene.globe.tilesLoaded) {
        terrainLoadedChecks = 0;
        terrainTimer = window.setTimeout(waitForTerrain, 100);
        return;
      }
      terrainLoadedChecks++;
      if (terrainLoadedChecks < 2) {
        terrainTimer = window.setTimeout(waitForTerrain, 100);
        return;
      }

      generateTimer = window.setTimeout(async () => {
        if (!viewer || viewer.isDestroyed() || generation !== taskGeneration) return;
        try {
          const texture = await generator.generateHeightMap(
            regionData.rectangle,
            params.textureSize,
          );
          if (generation !== taskGeneration) return;
          if (!texture) return;
          const data = generator.readHeightMapData();
          if (!data) return;
          createPreview(data);
          visualizer.show(regionData.rectangle, texture, {
            alpha: params.alpha,
            clampToGround: true,
          });
          if (!params.show) visualizer.hide();
          flyToTimer = window.setTimeout(() => visualizer?.flyTo(1.5), 350);
          addSamplePoints(regionData.rectangle, generation);
          setStatus("高度图已生成", "success");
          params.size = `${data.width} × ${data.height}`;
          params.heightRange = `${data.actualMinHeight.toFixed(1)} m - ${data.actualMaxHeight.toFixed(1)} m`;
          refreshPane();
        } catch (error) {
          if (!viewer || viewer.isDestroyed() || generation !== taskGeneration) return;
          console.error("生成高度图失败", error);
          setStatus(
            "高度图生成失败，请检查 Cesium.Ion.defaultAccessToken 配置、网络连接或重试",
            "error",
          );
          params.heightRange = error?.message || "生成失败";
          refreshPane();
        }
      }, 700);
    };
    waitForTerrain();
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
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-112.125, 36.075, 9000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
  });
  initGui(generateHeightMap);
  setStatus("正在加载世界地形...", "loading");

  Cesium.createWorldTerrainAsync({
    requestVertexNormals: true,
    requestWaterMask: true,
  })
    .then((terrainProvider) => {
      if (!viewer || viewer.isDestroyed() || initializationGeneration !== taskGeneration) {
        terrainProvider.destroy();
        return;
      }

      viewer.terrainProvider = terrainProvider;
      generator = new HeightMapGenerator(viewer, {
        debug: true
      });
      visualizer = new HeightMapVisualizer(viewer, generator);
      generateHeightMap();
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
  terrainTimer = clearTimer(terrainTimer);
  generateTimer = clearTimer(generateTimer);
  flyToTimer = clearTimer(flyToTimer);
  sampleTimer = clearTimer(sampleTimer);
  if (viewer && !viewer.isDestroyed()) viewer.camera.cancelFlight();
  if (pane) {
    pane.dispose();
    pane = null;
  }
  visualizer?.destroy();
  generator?.destroy();
  clearPreview();
  if (viewer && !viewer.isDestroyed()) viewer.destroy();
  viewer = null;
  generator = null;
  visualizer = null;
  statusElement = null;
  previewCanvas = null;
}
