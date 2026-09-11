<template>
  <div class="example-view">
    <div
      id="cesiumContainer"
      ref="cesiumContainer"
    ></div>
    <div class="normalmap-overlay">
      <div
        ref="statusElement"
        class="normalmap-status"
        role="status"
      ></div>
      <div class="normalmap-legend">
        <strong>视空间法线</strong>
        <span><i class="red"></i>X</span>
        <span><i class="green"></i>Y</span>
        <span><i class="blue"></i>Z</span>
      </div>
    </div>
  </div>
</template>

<script>
import * as NormalMapMapWorks from "./js/NormalMapMapWorks.js";

export default {
  name: "NormalMap",

  mounted() {
    NormalMapMapWorks.initMap(this.$refs.cesiumContainer, {
      statusElement: this.$refs.statusElement,
    });
  },

  beforeUnmount() {
    NormalMapMapWorks.destroy();
  },
};
</script>

<style scoped>
.example-view,
#cesiumContainer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.normalmap-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: none;
}

.normalmap-status,
.normalmap-legend {
  padding: 8px 14px;
  color: #b0b8d0;
  background: rgba(16, 20, 40, 0.82);
  border: 1px solid rgba(120, 160, 255, 0.28);
  border-radius: 999px;
  font-size: 12px;
}

.normalmap-status {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
}

.normalmap-status.success {
  color: #69f0ae;
  border-color: rgba(105, 240, 174, 0.45);
}

.normalmap-status.error {
  color: #ff8a9b;
  border-color: rgba(255, 138, 155, 0.55);
}

.normalmap-legend {
  position: absolute;
  bottom: 54px;
  left: 16px;
  display: flex;
  gap: 12px;
  align-items: center;
}

.normalmap-legend strong {
  color: #fff;
}

.normalmap-legend i {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 4px;
  border-radius: 50%;
}

.red {
  background: #ef4444;
}

.green {
  background: #22c55e;
}

.blue {
  background: #3b82f6;
}
</style>
