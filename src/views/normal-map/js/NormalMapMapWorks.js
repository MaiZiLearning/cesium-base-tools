import * as Cesium from "cesium";
import { Pane } from "tweakpane";
import { NormalMapShader } from "@/lib/normal-map/NormalMapShader.js";

const SCGIS_TILESET_URL =
  "https://www.scgis.net/services/longchang_3dtiles/file/tileset.json?ak=623d2c5223vxqc44b2cd3832989bfc21";

const params = {
  normalMode: true,
  status: "正在加载 3DTiles...",
};

let viewer = null;
let normalStage = null;
let tileset = null;
let pane = null;
let statusElement = null;
let initializationGeneration = 0;

function setStatus(message, tone = "") {
  params.status = message;
  if (!statusElement) return;
  statusElement.textContent = message;
  statusElement.className = `normalmap-status ${tone}`;
  pane?.refresh();
}

function setNormalMode(enabled) {
  params.normalMode = enabled;
  if (normalStage) normalStage.enabled = enabled;
  setStatus(
    enabled
      ? "法线模式已开启：RGB 对应视空间 XYZ 法线"
      : "法线模式已关闭：显示 3DTiles 原始画面",
    "success",
  );
  viewer?.scene.requestRender();
}

function createControlPanel() {
  pane = new Pane({
    title: "后处理法线图控制",
    expanded: true,
  });

  const normalFolder = pane.addFolder({
    title: "法线后处理",
  });
  normalFolder
    .addBinding(params, "normalMode", {
      label: "开启法线模式",
    })
    .on("change", (event) => {
      setNormalMode(event.value);
    });

  const statusFolder = pane.addFolder({
    title: "场景状态",
  });
  statusFolder.addBinding(params, "status", {
    label: "状态",
    readonly: true,
  });

  const infoFolder = pane.addFolder({
    title: "操作说明",
    expanded: false,
  });
  infoFolder.element.querySelector(".tp-fldv_c").innerHTML = `
    <div style="padding: 8px; font-size: 11px; line-height: 1.6; color: #ccc;">
      <p>示例使用公开 3DTiles 模型，不加载 Cesium World Terrain。</p>
      <p>开启法线模式后，后处理通过场景深度纹理重建视空间法线。</p>
      <p>RGB 分别表示编码后的视空间 X、Y、Z 法线分量。</p>
    </div>
  `;
}

async function loadTileset(generation) {
  const ownerViewer = viewer;
  const loadTileset = async (url) => {
    if (typeof Cesium.Cesium3DTileset.fromUrl === "function") {
      return Cesium.Cesium3DTileset.fromUrl(url);
    }
    return new Cesium.Cesium3DTileset({
      url,
    });
  };

  const loadedTileset = await loadTileset(SCGIS_TILESET_URL);
  if (
    !ownerViewer ||
    ownerViewer.isDestroyed() ||
    generation !== initializationGeneration
  ) {
    loadedTileset.destroy();
    return;
  }

  tileset = loadedTileset;
  ownerViewer.scene.primitives.add(loadedTileset);
  if (loadedTileset.readyPromise) {
    await loadedTileset.readyPromise;
  }

  if (
    !ownerViewer ||
    ownerViewer.isDestroyed() ||
    generation !== initializationGeneration
  ) {
    if (ownerViewer && !ownerViewer.isDestroyed()) {
      ownerViewer.scene.primitives.removeAndDestroy(loadedTileset);
    } else if (!loadedTileset.isDestroyed()) {
      loadedTileset.destroy();
    }
    return;
  }

  await ownerViewer.camera.flyToBoundingSphere(loadedTileset.boundingSphere, {
    duration: 1.2,
    offset: new Cesium.HeadingPitchRange(
      0,
      Cesium.Math.toRadians(-35),
      Math.max(loadedTileset.boundingSphere.radius * 2.8, 1500),
    ),
  });

  if (
    !ownerViewer ||
    ownerViewer.isDestroyed() ||
    generation !== initializationGeneration
  ) {
    if (!loadedTileset.isDestroyed()) {
      loadedTileset.destroy();
    }
    return;
  }

  setStatus(
    params.normalMode
      ? "3DTiles 已加载，法线模式已开启"
      : "3DTiles 已加载，法线模式已关闭",
    "success",
  );
  viewer.scene.requestRender();
}

export function initMap(container, elements = {}) {
  if (viewer) destroy();

  const generation = ++initializationGeneration;
  statusElement = elements.statusElement ?? null;
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
  });

  viewer._cesiumWidget._creditContainer.style.display = "none";
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.globe.enableLighting = true;

  normalStage = viewer.scene.postProcessStages.add(
    new Cesium.PostProcessStage({
      name: "view-space-normal-map",
      fragmentShader: NormalMapShader,
      enabled: params.normalMode,
    }),
  );

  createControlPanel();
  setStatus("正在加载 3DTiles...", "loading");

  loadTileset(generation).catch((error) => {
    if (
      !viewer ||
      viewer.isDestroyed() ||
      generation !== initializationGeneration
    ) {
      return;
    }
    console.error("加载 3DTiles 失败", error);
    setStatus(`3DTiles 加载失败：${error?.message || "请检查网络连接"}`, "error");
  });
}

export function destroy() {
  ++initializationGeneration;

  if (viewer && !viewer.isDestroyed()) {
    viewer.camera.cancelFlight();
  }

  if (pane) {
    pane.dispose();
    pane = null;
  }

  if (viewer && !viewer.isDestroyed() && normalStage) {
    viewer.scene.postProcessStages.remove(normalStage);
  }

  normalStage = null;

  if (viewer && !viewer.isDestroyed() && tileset) {
    viewer.scene.primitives.removeAndDestroy(tileset);
  }

  tileset = null;

  if (viewer && !viewer.isDestroyed()) {
    viewer.destroy();
  }

  viewer = null;
  statusElement = null;
}
