/**
 * 离屏渲染获取场景高度图（基于 Picking 离屏拾取视图 + 深度反投影）。
 *
 * 原理概述
 *   1. 在目标 Rectangle 中心上方构造一个俯视正交相机（OrthographicFrustum），
 *      正交视锥覆盖整个采样矩形。
 *   2. 临时把 scene.view 切换为 Picking 的离屏拾取视图（picking._pickOffscreenView），
 *      将其 viewport 设为 N×N、camera 设为俯视相机，
 *      手动驱动一次 frameState：passes.pick = true / passes.offscreen = true，
 *      执行 updateAndExecuteCommands，把当前可见几何（地形 + 3DTiles + Primitive 等）
 *      渲染到拾取 framebuffer 及其 pickDepth 附件。
 *   3. 读回每个 frustum 的 pickDepth RGBA 字节（packed depth），
 *      用 packedDepthScale (1, 1/255, 1/65025, 1/16581375) 反量化得到归一化深度 depth∈(0,1)，
 *      再换算到相机视锥内距离 distance = near + depth * (far - near)。
 *   4. 把每个像素的 (col, row) 映射到相机右向量/上向量上的偏移，
 *      还原世界坐标 Cartesian3，再用 Cartographic.fromCartesian 读取高程 height（米）。
 *   5. 同时构建一张 RGBA FLOAT 纹理（归一化高度 + 有效掩码）供 GPU 着色器采样。
 */

const PACKED_DEPTH_SCALE = new Cesium.Cartesian4(
  1.0,
  1.0 / 255.0,
  1.0 / 65025.0,
  1.0 / 16581375.0,
);

/**
 * @param {Cesium.Viewer} viewer - Cesium Viewer 实例
 * @param {Object} [options] - 配置选项
 * @param {boolean} [options.debug=false] - 是否启用调试日志
 * @param {number} [options.heightAbove=5000] - 离屏相机悬浮高度（米）
 * @param {number} [options.near=0.1] - 正交视锥 near（米）
 * @param {number} [options.far=10000] - 正交视锥 far（米）
 * @param {boolean} [options.waitForTerrain=false] - generate 时是否等待地形瓦片加载
 * @param {number} [options.terrainTimeoutMs=30000] - 等待地形超时（毫秒）
 * @param {boolean} [options.bilinearSample=true] - sampleHeight 是否双线性插值
 * @param {Cesium.BoundingSphere} [options.boundingSphere] - 3DTiles 包围球（用于调试和定位）
 */
function OffscreenHeightMapGenerator(viewer, options) {
  options = options ?? {};
  if (!viewer || !viewer.scene) {
    throw new TypeError("viewer must be a Cesium Viewer instance");
  }

  this._viewer = viewer;
  this._scene = viewer.scene;
  this._context = this._scene.context;

  this._debug = Boolean(options.debug ?? false);
  this._heightAbove = options.heightAbove ?? 5000;
  this._near = options.near ?? 0.1;
  this._far = options.far ?? 10000;
  this._waitForTerrain = options.waitForTerrain === true;
  this._terrainTimeoutMs = options.terrainTimeoutMs ?? 30000;
  this._useBilinearSample = options.bilinearSample !== false;
  this._boundingSphere = options.boundingSphere ?? null;
  this._tileset = options.tileset ?? null;
  this._generateGeneration = 0;

  this._picking = null;
  this._offscreenCamera = null;
  this._cameraPositionWC = null;
  this._cameraDirectionWC = null;
  this._cameraRightWC = null;
  this._cameraUpWC = null;
  this._tilesetPassState = null;

  this._rectangle = null;
  this._worldWidth = 0;
  this._worldHeight = 0;
  this._size = 0;
  this._minHeight = 0;
  this._maxHeight = 0;
  this._heightMapTexture = null;
  this._cachedData = null;
  this._lastDepths = null;
  this._lastFrustumIndices = null;
  this._lastValidFlags = null;
  this._destroyed = false;

  // 兼容旧有直接访问字段的代码
  this.rectangle = null;
  this.heightMapTexture = null;
  this.minHeight = 0;
  this.maxHeight = 0;
}

OffscreenHeightMapGenerator.PACKED_DEPTH_SCALE = PACKED_DEPTH_SCALE;

/* ===========================================================================
 * 日志
 * =========================================================================== */

OffscreenHeightMapGenerator.prototype._log = function (...args) {
  if (this._debug) console.log("[HeightMap]", ...args);
};

OffscreenHeightMapGenerator.prototype._warn = function (...args) {
  if (this._debug) console.warn("[HeightMap]", ...args);
};

OffscreenHeightMapGenerator.prototype._error = function (...args) {
  console.error("[HeightMap]", ...args);
};

/* ===========================================================================
 * 公开 API
 * =========================================================================== */

/**
 * 在指定矩形区域生成高度图（异步：等待地形 → 离屏渲染 → 读回）。
 * @param {Cesium.Rectangle} rectangle - 采样矩形（弧度）
 * @param {number} [size=1024] - 纹理分辨率（正方形）
 * @returns {Promise<Cesium.Texture|null>}
 */
OffscreenHeightMapGenerator.prototype.generate = async function (
  rectangle,
  size = 1024,
) {
  if (this._destroyed) return null;
  if (!(rectangle instanceof Cesium.Rectangle)) {
    throw new TypeError("rectangle must be a Cesium.Rectangle instance");
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new TypeError("size must be a positive number");
  }
  if (!this._context.depthTexture) {
    throw new Error("当前 WebGL 环境不支持深度纹理，无法生成离屏高度图");
  }
  size |= 0;

  const generation = ++this._generateGeneration;
  this._log("=== 开始生成高度图 ===", rectangle, size);

  this._destroyResources();

  this._createOffscreenCamera(rectangle);

  if (this._waitForTerrain) {
    await this._waitForTerrainLoaded();
    if (this._destroyed || generation !== this._generateGeneration) return null;
  }

  this._size = size;
  const result = this._renderAndExtract(size);
  if (this._destroyed || generation !== this._generateGeneration) return null;

  this._buildHeightTexture(
    result.heights,
    result.minHeight,
    result.maxHeight,
    result.validCount,
  );

  this._log(
    "=== 高度图生成完成 ===",
    `valid=${result.validCount}/${size * size}`,
    `range=[${result.minHeight.toFixed(2)}, ${result.maxHeight.toFixed(2)}] m`,
  );

  return this._heightMapTexture;
};

/**
 * 获取高度图纹理。
 * @returns {Cesium.Texture|null}
 */
OffscreenHeightMapGenerator.prototype.getHeightMapTexture = function () {
  if (this._destroyed) return null;
  return this._heightMapTexture;
};

/**
 * 设置需要参与离屏预加载的 3DTiles。
 * @param {Cesium.Cesium3DTileset|null} tileset
 */
OffscreenHeightMapGenerator.prototype.setTileset = function (tileset) {
  if (this._destroyed) return;
  this._tileset = tileset ?? null;
};

/**
 * 读取最近一次生成使用的离屏相机，供调试可视化使用。
 * @returns {Cesium.Camera|null}
 */
OffscreenHeightMapGenerator.prototype.getOffscreenCamera = function () {
  if (this._destroyed) return null;
  return this._offscreenCamera;
};

/**
 * 读取（并缓存）高度图原始数据。
 * @returns {{width:number,height:number,data:Float32Array,heights:Float32Array,minHeight:number,maxHeight:number,validCount:number,rectangle:Cesium.Rectangle}|null}
 */
OffscreenHeightMapGenerator.prototype.readHeightMapData = function () {
  if (this._destroyed) return null;
  return this._cachedData;
};

/**
 * 在 (lon, lat)（弧度）位置查询高度（米）。
 * @param {number} longitude - 经度（弧度）
 * @param {number} latitude - 纬度（弧度）
 * @returns {number|null} 高度值（米）
 */
OffscreenHeightMapGenerator.prototype.sampleHeight = function (
  longitude,
  latitude,
) {
  if (this._destroyed) return null;
  const data = this._cachedData;
  if (!data) {
    this._warn("sampleHeight: 高度图尚未生成");
    return null;
  }

  const rect = data.rectangle;
  if (
    longitude < rect.west ||
    longitude > rect.east ||
    latitude < rect.south ||
    latitude > rect.north
  ) {
    return null;
  }

  const u = (longitude - rect.west) / (rect.east - rect.west);
  const v = (latitude - rect.south) / (rect.north - rect.south);

  if (this._useBilinearSample) {
    return this._bilinearSample(data, u, v);
  }
  return this._nearestSample(data, u, v);
};

/**
 * 批量采样。
 * @param {Array<{longitude:number,latitude:number}>|Array<[number,number]>} positions
 * @returns {Array<number|null>}
 */
OffscreenHeightMapGenerator.prototype.sampleHeights = function (positions) {
  if (this._destroyed) return [];
  if (!Array.isArray(positions)) return [];
  return positions.map((p) => {
    if (!p) return null;
    const lon = Array.isArray(p) ? p[0] : p.longitude;
    const lat = Array.isArray(p) ? p[1] : p.latitude;
    return this.sampleHeight(lon, lat);
  });
};

/**
 * 根据高度图像素坐标还原世界坐标（Cartesian3）。
 * 像素坐标系采用 canvas / top-left 原点约定（与 ImageData 一致）。
 * @param {number} px - 像素 x（0..size-1，从左到右）
 * @param {number} py - 像素 y（0..size-1，从上到下）
 * @param {Cesium.Cartesian3} [result]
 * @returns {Cesium.Cartesian3|null}
 */
OffscreenHeightMapGenerator.prototype.getPositionAtPixel = function (
  px,
  py,
  result,
) {
  if (this._destroyed) return null;
  const data = this._cachedData;
  if (!data || !this._offscreenCamera) return null;

  const size = this._size;
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  if (px < 0 || px >= size || py < 0 || py >= size) return null;

  const row = size - 1 - py;
  const col = px;
  const idx = row * size + col;
  if (data.validFlags?.[idx] !== 1) return null;
  const depth = data.depths[idx];
  if (!(depth > 0 && depth < 1)) return null;

  const W = this._worldWidth;
  const H = this._worldHeight;
  const longitude =
    data.rectangle.west + ((col + 0.5) / size) * (data.rectangle.east - data.rectangle.west);
  const latitude =
    data.rectangle.south + ((row + 0.5) / size) * (data.rectangle.north - data.rectangle.south);
  const targetWorld = Cesium.Cartographic.toCartesian(
    new Cesium.Cartographic(longitude, latitude, 0),
  );
  const targetOffset = Cesium.Cartesian3.subtract(
    targetWorld,
    this._cameraPositionWC,
    new Cesium.Cartesian3(),
  );
  const targetEastOffset = Cesium.Cartesian3.dot(
    targetOffset,
    this._cameraRightWC,
  );
  const targetNorthOffset = Cesium.Cartesian3.dot(
    targetOffset,
    this._cameraUpWC,
  );
  const sourceCol = Math.round(
    ((targetEastOffset / W) + 0.5) * size - 0.5,
  );
  const sourceRow = Math.round(
    ((targetNorthOffset / H) + 0.5) * size - 0.5,
  );
  if (
    sourceCol < 0 ||
    sourceCol >= size ||
    sourceRow < 0 ||
    sourceRow >= size
  ) {
    return null;
  }

  const offsetCol = ((sourceCol + 0.5) / size - 0.5) * W;
  const offsetRow = ((sourceRow + 0.5) / size - 0.5) * H;

  const origin = Cesium.Cartesian3.clone(
    this._cameraPositionWC,
    result || new Cesium.Cartesian3(),
  );
  const tmp = new Cesium.Cartesian3();
  Cesium.Cartesian3.multiplyByScalar(this._cameraRightWC, offsetCol, tmp);
  Cesium.Cartesian3.add(origin, tmp, origin);
  Cesium.Cartesian3.multiplyByScalar(this._cameraUpWC, offsetRow, tmp);
  Cesium.Cartesian3.add(origin, tmp, origin);

  const distance = this._depthToDistance(depth, idx);
  return Cesium.Ray.getPoint(
    new Cesium.Ray(origin, this._cameraDirectionWC),
    distance,
    origin,
  );
};

/**
 * 根据高度图像素坐标还原经纬度+高程（Cartographic）。
 * @param {number} px
 * @param {number} py
 * @returns {Cesium.Cartographic|null}
 */
OffscreenHeightMapGenerator.prototype.getCartographicAtPixel = function (
  px,
  py,
) {
  if (this._destroyed) return null;
  const pos = this.getPositionAtPixel(px, py);
  if (!pos) return null;
  return Cesium.Cartographic.fromCartesian(pos);
};

/**
 * 获取像素位置的归一化深度（与 Cesium packed depth 一致，[0,1]）。
 * @param {number} px
 * @param {number} py
 * @returns {number|null}
 */
OffscreenHeightMapGenerator.prototype.getDepthAtPixel = function (px, py) {
  if (this._destroyed) return null;
  const data = this._cachedData;
  if (!data) return null;
  const size = this._size;
  if (px < 0 || px >= size || py < 0 || py >= size) return null;
  const row = size - 1 - py;
  const idx = row * size + px;
  const d = data.depths[idx];
  return d > 0 && d < 1 ? d : null;
};

/**
 * 查询对象是否已销毁。
 * @returns {boolean}
 */
OffscreenHeightMapGenerator.prototype.isDestroyed = function () {
  return this._destroyed;
};

/**
 * 销毁所有 GPU 和 CPU 资源。
 */
OffscreenHeightMapGenerator.prototype.destroy = function () {
  if (this._destroyed) return;
  this._destroyed = true;
  ++this._generateGeneration;
  this._destroyResources();
  this._offscreenCamera = null;
  this._cameraPositionWC = null;
  this._cameraDirectionWC = null;
  this._cameraRightWC = null;
  this._cameraUpWC = null;
  this._picking = this._picking && this._picking.destroy();
  this._tilesetPassState = null;
  this._rectangle = null;
  this._cachedData = null;
  this._scene = null;
  this._context = null;
  this._viewer = null;

  this.rectangle = null;
  this.heightMapTexture = null;
};

/* ===========================================================================
 * 内部方法
 * =========================================================================== */

OffscreenHeightMapGenerator.prototype._waitForTerrainLoaded = async function () {
  const scene = this._scene;
  if (!scene) return false;

  const deadline = Date.now() + this._terrainTimeoutMs;
  let stableFrames = 0;
  let renderedFrame = false;

  while (Date.now() < deadline) {
    if (this._destroyed) return false;

    // Globe 没有独立的 PRELOAD 通道。必须使用离屏相机执行完整渲染流程，
    // 才能遍历地形并将请求加入加载队列。
    this._renderPreloadFrame();
    renderedFrame = true;

    const terrainLoaded = !scene.globe?.show || scene.globe.tilesLoaded;
    const tilesetLoaded =
      !this._tileset?.show || this._tileset.tilesLoaded;
    if (terrainLoaded && tilesetLoaded) {
      stableFrames += 1;
      if (stableFrames >= 3) {
        this._log("目标相机瓦片已稳定", {
          terrainLoaded,
          tilesetLoaded,
        });
        return true;
      }
    } else {
      stableFrames = 0;
    }

    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  this._warn(
    `_waitForTerrainLoaded: 超时 ${this._terrainTimeoutMs}ms，目标相机仍可能未加载完成`,
  );
  return renderedFrame;
};

/*
 * 使用离屏相机执行完整的 Cesium 渲染流程。
 * 这样地形 Quadtree 和可见 3DTiles 都会按目标相机进行遍历，
 * 而不是依赖不会主动请求缺失瓦片的 PICK 通道。
 */
OffscreenHeightMapGenerator.prototype._renderPreloadFrame = function () {
  if (
    this._destroyed ||
    !this._scene ||
    !this._offscreenCamera ||
    typeof this._scene.forceRender !== "function"
  ) {
    return;
  }

  const scene = this._scene;
  const sceneCamera = scene.camera;
  const savedCamera = Cesium.Camera.clone(sceneCamera);
  try {
    Cesium.Camera.clone(this._offscreenCamera, sceneCamera);
    scene.forceRender();
  } finally {
    Cesium.Camera.clone(savedCamera, sceneCamera);
  }
};

OffscreenHeightMapGenerator.prototype._createOffscreenCamera = function (
  rectangle,
) {
  this._rectangle = rectangle;
  this.rectangle = rectangle;

  const centerCarto = new Cesium.Cartographic(
    (rectangle.west + rectangle.east) * 0.5,
    (rectangle.south + rectangle.north) * 0.5,
    0,
  );
  const centerCartesian = Cesium.Cartographic.toCartesian(centerCarto);
  const enuFrame = Cesium.Transforms.eastNorthUpToFixedFrame(
    centerCartesian,
    Cesium.Ellipsoid.WGS84,
  );
  const east = Cesium.Matrix4.getColumn(
    enuFrame,
    0,
    new Cesium.Cartesian3(),
  );
  const north = Cesium.Matrix4.getColumn(
    enuFrame,
    1,
    new Cesium.Cartesian3(),
  );
  const normal = Cesium.Matrix4.getColumn(
    enuFrame,
    2,
    new Cesium.Cartesian3(),
  );
  const cornerPositions = [
    Cesium.Cartographic.toCartesian(
      new Cesium.Cartographic(rectangle.west, rectangle.south, 0),
    ),
    Cesium.Cartographic.toCartesian(
      new Cesium.Cartographic(rectangle.east, rectangle.south, 0),
    ),
    Cesium.Cartographic.toCartesian(
      new Cesium.Cartographic(rectangle.east, rectangle.north, 0),
    ),
    Cesium.Cartographic.toCartesian(
      new Cesium.Cartographic(rectangle.west, rectangle.north, 0),
    ),
  ];

  let minEast = Infinity;
  let maxEast = -Infinity;
  let minNorth = Infinity;
  let maxNorth = -Infinity;
  cornerPositions.forEach((corner) => {
    const offset = Cesium.Cartesian3.subtract(
      corner,
      centerCartesian,
      new Cesium.Cartesian3(),
    );
    const eastOffset = Cesium.Cartesian3.dot(offset, east);
    const northOffset = Cesium.Cartesian3.dot(offset, north);
    minEast = Math.min(minEast, eastOffset);
    maxEast = Math.max(maxEast, eastOffset);
    minNorth = Math.min(minNorth, northOffset);
    maxNorth = Math.max(maxNorth, northOffset);
  });

  // Rectangle、正交视锥和纹理使用同一个未扩展的 ENU 覆盖范围。
  // 如果扩展视锥后再将整张纹理拉伸回原始 Rectangle，会导致每个纹理像素的地理位置不准确。
  const worldWidth = Math.max(maxEast - minEast, 1);
  const worldHeight = Math.max(maxNorth - minNorth, 1);
  const footprintEast = (minEast + maxEast) * 0.5;
  const footprintNorth = (minNorth + maxNorth) * 0.5;
  const aspectRatio = worldWidth / worldHeight;
  const cameraHeight = Math.max(this._heightAbove, worldWidth, worldHeight);
  const cameraPos = Cesium.Cartesian3.clone(centerCartesian);
  Cesium.Cartesian3.multiplyByScalar(east, footprintEast, east);
  Cesium.Cartesian3.add(cameraPos, east, cameraPos);
  Cesium.Cartesian3.multiplyByScalar(north, footprintNorth, north);
  Cesium.Cartesian3.add(cameraPos, north, cameraPos);
  Cesium.Cartesian3.multiplyByScalar(normal, cameraHeight, normal);
  Cesium.Cartesian3.add(cameraPos, normal, cameraPos);

  const far = Math.max(
    this._far,
    cameraHeight + Math.max(worldWidth, worldHeight) * 0.75,
  );
  const direction = Cesium.Cartesian3.negate(
    Cesium.Matrix4.getColumn(enuFrame, 2, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  // 相机平移后重新设置水平轴，但保持与覆盖范围计算完全一致的 ENU 方向。
  const camera = new Cesium.Camera(this._scene);
  camera.position = cameraPos;
  camera.direction = direction;
  camera.up = Cesium.Matrix4.getColumn(
    enuFrame,
    1,
    new Cesium.Cartesian3(),
  );
  camera.right = Cesium.Matrix4.getColumn(
    enuFrame,
    0,
    new Cesium.Cartesian3(),
  );
  camera.frustum = new Cesium.OrthographicFrustum({
    width: worldWidth,
    aspectRatio,
    near: this._near,
    far,
  });
  // 保存一组固定的世界坐标系相机基向量，用于视锥裁剪和 CPU 射线重建。
  // 避免同时使用相机局部字段和延迟计算的世界坐标字段。
  this._cameraPositionWC = Cesium.Cartesian3.clone(camera.positionWC);
  this._cameraDirectionWC = Cesium.Cartesian3.clone(camera.directionWC);
  this._cameraRightWC = Cesium.Cartesian3.clone(camera.rightWC);
  this._cameraUpWC = Cesium.Cartesian3.clone(camera.upWC);

  this._offscreenCamera = camera;
  this._worldWidth = worldWidth;
  this._worldHeight = worldHeight;

  this._log(
    "相机: pos=",
    cameraPos,
    " 视锥宽(m)=",
    worldWidth,
    "视锥高(m)=",
    worldHeight,
    "near/far=",
    this._near,
    far,
  );
};

OffscreenHeightMapGenerator.prototype._renderAndExtract = function (size) {
  const scene = this._scene;
  const context = this._context;
  const frameState = scene.frameState;

  if (!context.depthTexture) {
    throw new Error("当前 WebGL 环境不支持深度纹理，无法生成离屏高度图");
  }

  if (!this._picking) {
    this._picking = new Cesium.Picking(scene);
  }
  const picking = this._picking;
  const view = picking._pickOffscreenView;

  const savedSceneView = scene.view;
  const savedViewViewport = view.viewport;
  const savedPassViewport = view.passState.viewport;
  const savedViewCamera = view.camera;
  const savedFrameStateCamera = frameState.camera;
  const savedFrameStateCullingVolume = frameState.cullingVolume;
  const savedFrameStateOccluder = frameState.occluder;
  const savedInvertClass = frameState.invertClassification;
  const savedPick = frameState.passes.pick;
  const savedOffscreen = frameState.passes.offscreen;
  const savedTilesetPassState = frameState.tilesetPassState;
  const savedUseDepthPicking = scene.useDepthPicking;

  const viewportRect = new Cesium.BoundingRectangle(0, 0, size, size);
  view.viewport = viewportRect;
  view.passState.viewport = viewportRect;
  view.camera = this._offscreenCamera;
  scene.view = view;

  if (!this._tilesetPassState) {
    this._tilesetPassState = new Cesium.Cesium3DTilePassState({
      pass: Cesium.Cesium3DTilePass.PICK,
    });
  }
  const tilesetPassState = this._tilesetPassState;
  tilesetPassState.camera = this._offscreenCamera;
  tilesetPassState.cullingVolume =
    this._offscreenCamera.frustum.computeCullingVolume(
      this._cameraPositionWC,
      this._cameraDirectionWC,
      this._cameraUpWC,
    );

  const scratch = new Cesium.BoundingRectangle();
  Cesium.BoundingRectangle.clone(view.viewport, scratch);
  let result = null;
  let beganFramebuffer = false;
  try {
    const passState = view.pickFramebuffer.begin(scratch, view.viewport);
    beganFramebuffer = true;
    scene.jobScheduler.disableThisFrame();
    scene.updateFrameState();
    frameState.cullingVolume =
      this._offscreenCamera.frustum.computeCullingVolume(
        this._cameraPositionWC,
        this._cameraDirectionWC,
        this._cameraUpWC,
      );
    frameState.invertClassification = false;
    frameState.passes.pick = true;
    frameState.passes.offscreen = true;
    frameState.tilesetPassState = tilesetPassState;
    scene.useDepthPicking = true;
    context.uniformState.update(frameState);

    scene.updateEnvironment();
    scene.updateAndExecuteCommands(passState, Cesium.Color.TRANSPARENT);
    scene.resolveFramebuffers(passState);

    // 高度图只读取 pickDepth；end() 仅用于颜色拾取对象 ID，这里不重复读回颜色。
    result = this._extractHeightsFromPickDepth(view, size);
  } catch (err) {
    this._error("离屏渲染执行失败:", err);
    throw err;
  } finally {
    scene.view = savedSceneView;
    view.viewport = savedViewViewport;
    view.passState.viewport = savedPassViewport;
    view.camera = savedViewCamera;
    frameState.camera = savedFrameStateCamera;
    frameState.cullingVolume = savedFrameStateCullingVolume;
    frameState.occluder = savedFrameStateOccluder;
    frameState.invertClassification = savedInvertClass;
    frameState.passes.pick = savedPick;
    frameState.passes.offscreen = savedOffscreen;
    frameState.tilesetPassState = savedTilesetPassState;
    scene.useDepthPicking = savedUseDepthPicking;
    if (beganFramebuffer) {
      context.endFrame();
    }
  }

  return {
    heights: result.heights,
    validCount: result.validCount,
    minHeight: result.minHeight,
    maxHeight: result.maxHeight,
  };
};

OffscreenHeightMapGenerator.prototype._extractHeightsFromPickDepth = function (
  view,
  size,
) {
  const scene = this._scene;
  const context = this._context;
  const rectangle = this._rectangle;

  const heights = new Float32Array(size * size);
  const depths = new Float32Array(size * size);
  const validFlags = new Uint8Array(size * size);
  const frustumIndices = new Uint8Array(size * size);
  const depthLayers = [];

  const numFrustums = view.frustumCommandsList.length;
  this._log(
    "pickDepths.length =",
    view.pickDepths.length,
    "numFrustums =",
    numFrustums,
  );
  for (let k = 0; k < numFrustums; ++k) {
    const fc = view.frustumCommandsList[k];
    const counts = {};
    const PassEnum = Cesium.Pass;
    for (const key in PassEnum) {
      if (typeof PassEnum[key] === "number") {
        counts[PassEnum[key]] = (fc.commands[PassEnum[key]] || []).length;
      }
    }
    this._log(
      `  frustum[${k}] near=${fc.near.toFixed(2)} far=${fc.far.toFixed(2)}`,
      "commandsPerPass=",
      JSON.stringify(counts),
    );

    const pickDepth = view.pickDepths[k];
    if (!pickDepth || !pickDepth.framebuffer) continue;
    const pixelDepths = this._readPackedDepth(
      context,
      pickDepth.framebuffer,
      size,
    );
    const near = fc.near * (k !== 0 ? scene.opaqueFrustumNearOffset : 1.0);
    const far = fc.far;
    depthLayers.push({ pixelDepths, near, far, index: k });

    let dMin = Infinity;
    let dMax = -Infinity;
    let dSum = 0;
    let dCount = 0;
    for (let j = 0; j < pixelDepths.length; ++j) {
      const d = pixelDepths[j];
      if (d > 0 && d < 1) {
        dMin = Math.min(dMin, d);
        dMax = Math.max(dMax, d);
        dSum += d;
        dCount++;
      }
    }
    this._log(
      `  frustum[${k}] depth: min=${dMin.toFixed(4)} max=${dMax.toFixed(4)} mean=${dCount ? (dSum / dCount).toFixed(4) : "N/A"} valid=${dCount}/${pixelDepths.length}`,
    );
  }

  this._frustumRanges = new Array(numFrustums);
  for (const layer of depthLayers) {
    this._frustumRanges[layer.index] = {
      near: layer.near,
      far: layer.far,
    };
  }

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  let validCount = 0;
  const origin = new Cesium.Cartesian3();
  const tmp = new Cesium.Cartesian3();
  const targetWorld = new Cesium.Cartesian3();
  const ray = new Cesium.Ray(
    this._cameraPositionWC,
    this._cameraDirectionWC,
  );
  const longitudeRange = rectangle.east - rectangle.west;
  const latitudeRange = rectangle.north - rectangle.south;

  // 渲染目标是规则的 ENU 网格，而 Cesium Rectangle 是规则的经纬度网格。
  // 通过同一个相机覆盖范围重新投影每个输出像素，使像素值对应真实的
  // Rectangle 地理位置，而不是将 ENU 图像直接拉伸到 Rectangle 上。
  for (let row = 0; row < size; ++row) {
    const latitude =
      rectangle.south + ((row + 0.5) / size) * latitudeRange;
    for (let col = 0; col < size; ++col) {
      const longitude =
        rectangle.west + ((col + 0.5) / size) * longitudeRange;
      const targetCartographic = new Cesium.Cartographic(
        longitude,
        latitude,
        0,
      );
      Cesium.Cartographic.toCartesian(
        targetCartographic,
        Cesium.Ellipsoid.WGS84,
        targetWorld,
      );
      const targetOffset = Cesium.Cartesian3.subtract(
        targetWorld,
        this._cameraPositionWC,
        tmp,
      );
      const eastOffset = Cesium.Cartesian3.dot(
        targetOffset,
        this._cameraRightWC,
      );
      const northOffset = Cesium.Cartesian3.dot(
        targetOffset,
        this._cameraUpWC,
      );
      const sourceX = ((eastOffset / this._worldWidth) + 0.5) * size - 0.5;
      const sourceY = ((northOffset / this._worldHeight) + 0.5) * size - 0.5;
      const sourceCol = Math.round(sourceX);
      const sourceRow = Math.round(sourceY);
      if (
        sourceCol < 0 ||
        sourceCol >= size ||
        sourceRow < 0 ||
        sourceRow >= size
      ) {
        continue;
      }

      let best = null;
      const sourceIndex = sourceRow * size + sourceCol;
      for (const layer of depthLayers) {
        const depth = layer.pixelDepths[sourceIndex];
        if (!(depth > 0 && depth < 1)) continue;
        const distance = layer.near + depth * (layer.far - layer.near);
        if (!best || distance < best.distance) {
          best = { depth, distance, layer };
        }
      }
      if (!best) continue;

      const colOff = ((sourceCol + 0.5) / size - 0.5) * this._worldWidth;
      const rowOff = ((sourceRow + 0.5) / size - 0.5) * this._worldHeight;
      Cesium.Cartesian3.clone(this._cameraPositionWC, origin);
      Cesium.Cartesian3.multiplyByScalar(
        this._cameraRightWC,
        colOff,
        tmp,
      );
      Cesium.Cartesian3.add(origin, tmp, origin);
      Cesium.Cartesian3.multiplyByScalar(this._cameraUpWC, rowOff, tmp);
      Cesium.Cartesian3.add(origin, tmp, origin);
      Cesium.Cartesian3.clone(origin, ray.origin);
      const worldPos = Cesium.Ray.getPoint(
        ray,
        best.distance,
        origin,
      );
      const carto = Cesium.Cartographic.fromCartesian(worldPos);
      const height = carto.height;
      if (!Number.isFinite(height)) continue;

      const outputIndex = row * size + col;
      heights[outputIndex] = height;
      depths[outputIndex] = best.depth;
      validFlags[outputIndex] = 1;
      frustumIndices[outputIndex] = best.layer.index;
      validCount++;
      minHeight = Math.min(minHeight, height);
      maxHeight = Math.max(maxHeight, height);
    }
  }

  if (validCount === 0) {
    minHeight = 0;
    maxHeight = 0;
  }

  this._minHeight = minHeight;
  this._maxHeight = maxHeight;
  this.minHeight = minHeight;
  this.maxHeight = maxHeight;
  this._lastDepths = depths;
  this._lastFrustumIndices = frustumIndices;
  this._lastValidFlags = validFlags;

  return {
    heights,
    validCount,
    minHeight,
    maxHeight,
  };
};

OffscreenHeightMapGenerator.prototype._readPackedDepth = function (
  context,
  framebuffer,
  size,
) {
  const pixels = context.readPixels({
    x: 0,
    y: 0,
    width: size,
    height: size,
    framebuffer,
  });
  const packed = Cesium.Cartesian4.unpackArray(pixels);
  const out = new Float32Array(packed.length);
  for (let i = 0; i < packed.length; i++) {
    const t = packed[i];
    Cesium.Cartesian4.divideByScalar(t, 255.0, t);
    out[i] = Cesium.Cartesian4.dot(t, PACKED_DEPTH_SCALE);
  }
  return out;
};

OffscreenHeightMapGenerator.prototype._buildHeightTexture = function (
  heights,
  minHeight,
  maxHeight,
  validCount,
) {
  const size = this._size;
  const range = maxHeight > minHeight ? maxHeight - minHeight : 1;
  const data = new Float32Array(size * size * 4);

  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    const o = i * 4;
    if (this._lastValidFlags?.[i]) {
      const norm = (h - minHeight) / range;
      data[o] = norm;
      data[o + 1] = norm;
      data[o + 2] = norm;
      data[o + 3] = 1;
    } else {
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = 0;
    }
  }

  const texture = new Cesium.Texture({
    context: this._context,
    width: size,
    height: size,
    pixelFormat: Cesium.PixelFormat.RGBA,
    pixelDatatype: Cesium.PixelDatatype.FLOAT,
    flipY: false,
    source: { width: size, height: size, arrayBufferView: data },
    sampler: new Cesium.Sampler({
      minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
      magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
      wrapS: Cesium.TextureWrap.CLAMP_TO_EDGE,
      wrapT: Cesium.TextureWrap.CLAMP_TO_EDGE,
    }),
  });

  this._heightMapTexture = texture;
  this.heightMapTexture = texture;
  this._cachedData = {
    width: size,
    height: size,
    data,
    heights,
    depths: this._lastDepths,
    frustumIndices: this._lastFrustumIndices,
    validFlags: this._lastValidFlags,
    minHeight,
    maxHeight,
    validCount,
    rectangle: this._rectangle,
  };
  this._lastDepths = null;
  this._lastFrustumIndices = null;
  this._lastValidFlags = null;
};

OffscreenHeightMapGenerator.prototype._nearestSample = function (data, u, v) {
  const w = data.width;
  const h = data.height;
  const x = Math.min(w - 1, Math.max(0, Math.floor(u * (w - 1))));
  const y = Math.min(h - 1, Math.max(0, Math.floor(v * (h - 1))));
  return data.validFlags?.[y * w + x] === 1 ? data.heights[y * w + x] : null;
};

OffscreenHeightMapGenerator.prototype._bilinearSample = function (data, u, v) {
  const w = data.width;
  const h = data.height;
  const fx = u * (w - 1);
  const fy = v * (h - 1);
  const x0 = Math.floor(fx);
  const x1 = Math.min(w - 1, x0 + 1);
  const y0 = Math.floor(fy);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const h00 = data.heights[y0 * w + x0];
  const h10 = data.heights[y0 * w + x1];
  const h01 = data.heights[y1 * w + x0];
  const h11 = data.heights[y1 * w + x1];

  if (
    data.validFlags?.[y0 * w + x0] !== 1 ||
    data.validFlags?.[y0 * w + x1] !== 1 ||
    data.validFlags?.[y1 * w + x0] !== 1 ||
    data.validFlags?.[y1 * w + x1] !== 1
  ) {
    return this._nearestSample(data, u, v);
  }
  const a = h00 * (1 - tx) + h10 * tx;
  const b = h01 * (1 - tx) + h11 * tx;
  return a * (1 - ty) + b * ty;
};

OffscreenHeightMapGenerator.prototype._depthToDistance = function (
  depth,
  pixelIndex,
) {
  const data = this._cachedData;
  const ranges = this._frustumRanges;
  const fi = data?.frustumIndices
    ? data.frustumIndices[pixelIndex]
    : 0;
  const range = ranges?.[fi];
  if (range) {
    return range.near + depth * (range.far - range.near);
  }
  const frustum = this._offscreenCamera.frustum;
  return frustum.near + depth * (frustum.far - frustum.near);
};

OffscreenHeightMapGenerator.prototype._destroyResources = function () {
  if (
    this._heightMapTexture &&
    !this._heightMapTexture.isDestroyed()
  ) {
    this._heightMapTexture.destroy();
  }
  this._heightMapTexture = null;
  this.heightMapTexture = null;
  this._cachedData = null;
  this._lastDepths = null;
  this._lastFrustumIndices = null;
  this._lastValidFlags = null;
  this._frustumRanges = null;
  this._minHeight = 0;
  this._maxHeight = 0;
  this.minHeight = 0;
  this.maxHeight = 0;
  this._rectangle = null;
  this.rectangle = null;
};

export default OffscreenHeightMapGenerator;
