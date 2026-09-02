<!--
 * OffscreenHeightMap.vue -- 基于离屏渲染的 Cesium 地形高度图示例
 *
 * 使用 OffscreenHeightMapGenerator 通过 Cesium Picking 系统
 * 离屏渲染获取场景高度图（地形 + 3DTiles 等合成表面）。
 -->
<template>
  <div class="example-view">
    <div id="cesiumContainer" ref="cesiumContainer"></div>
    <div class="heightmap-overlay">
      <canvas
        ref="previewCanvas"
        class="heightmap-preview-canvas"
        aria-label="高度图预览"
        hidden
      ></canvas>
      <div ref="statusElement" class="heightmap-status" role="status"></div>
    </div>
  </div>
</template>

<script>
import * as OffscreenHeightMapMapWorks from "./js/OffscreenHeightMapMapWorks.js";

export default {
  name: "OffscreenHeightMap",

  mounted() {
    OffscreenHeightMapMapWorks.initMap(this.$refs.cesiumContainer, {
      previewCanvas: this.$refs.previewCanvas,
      statusElement: this.$refs.statusElement,
    });
  },

  beforeUnmount() {
    OffscreenHeightMapMapWorks.destroy();
  },
};
</script>

<style scoped>
.example-view {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

#cesiumContainer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.heightmap-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: none;
}

.heightmap-preview-canvas,
.heightmap-status {
  pointer-events: auto;
}

.heightmap-preview-canvas {
  position: absolute;
  left: 16px;
  bottom: 54px;
  width: 220px;
  height: 220px;
  object-fit: contain;
  background: #020617;
  border: 1px solid rgba(148, 163, 184, 0.45);
  border-radius: 4px;
  image-rendering: pixelated;
}

.heightmap-status {
  position: absolute;
  bottom: 16px;
  left: 50%;
  max-width: calc(100% - 32px);
  padding: 6px 14px;
  color: #b0b8d0;
  background: rgba(16, 20, 40, 0.78);
  border: 1px solid rgba(120, 160, 255, 0.22);
  border-radius: 999px;
  transform: translateX(-50%);
  font-size: 12px;
  white-space: nowrap;
}

.heightmap-status.loading {
  color: #8fd3ff;
  border-color: rgba(120, 160, 255, 0.45);
}

.heightmap-status.success {
  color: #69f0ae;
  border-color: rgba(105, 240, 174, 0.45);
}

.heightmap-status.error {
  color: #ff8a9b;
  border-color: rgba(255, 138, 155, 0.55);
}

@media (max-width: 720px) {
  .heightmap-preview-canvas {
    left: auto;
    right: 10px;
    bottom: 54px;
    width: 156px;
    height: 156px;
  }
}
</style>
