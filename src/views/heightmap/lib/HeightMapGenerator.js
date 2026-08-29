/**
 * 根据最高等级地形瓦片生成高度图。
 */
import {
  BoundingRectangle,
  Buffer,
  BufferUsage,
  ClearCommand,
  Color,
  ComponentDatatype,
  DrawCommand,
  Framebuffer,
  IndexDatatype,
  Math as CesiumMath,
  Pass,
  PassState,
  PixelDatatype,
  PixelFormat,
  Rectangle,
  RenderState,
  Sampler,
  ShaderProgram,
  Texture,
  TextureMagnificationFilter,
  TextureMinificationFilter,
  VertexArray,
} from "cesium";

/**
 * @param {Cesium.Viewer} viewer - Cesium Viewer 实例
 * @param {Object} [options] - 配置选项
 * @param {boolean} [options.debug=false] - 是否启用调试日志
 */
function HeightMapGenerator(viewer, options) {
  options = options ?? {};
  if (!viewer || !viewer.scene) {
    throw new TypeError("viewer must be a Cesium Viewer instance");
  }

  this._viewer = viewer;
  this._scene = viewer.scene;
  this._context = this._scene.context;
  this._terrainProvider = viewer.terrainProvider;

  this._heightMapTexture = null;
  this._depthTexture = null;
  this._heightMapFramebuffer = null;
  this._drawCommands = [];
  this._tileNDCRanges = [];
  this._sharedShaderProgram = null;
  this._cachedHeightMapData = null;
  this._actualTargetRectangle = null;
  this._globalMinHeight = 0;
  this._globalMaxHeight = 1000;
  this._globalHeightRange = 1000;
  this._debug = Boolean(options.debug ?? false);
  this._destroyed = false;
  this._generationToken = 0;
}

/* ===========================================================================
 * 日志
 * =========================================================================== */

HeightMapGenerator.prototype._log = function (...args) {
  if (this._debug) console.log(...args);
};

HeightMapGenerator.prototype._warn = function (...args) {
  if (this._debug) console.warn(...args);
};

HeightMapGenerator.prototype._error = function (...args) {
  console.error(...args);
};

/* ===========================================================================
 * 公开 API
 * =========================================================================== */

/**
 * 生成高度图。
 * @param {Cesium.Rectangle} rectangle - 高度图覆盖的矩形范围
 * @param {number} [textureSize=1024] - 高度图边长
 * @returns {Promise<Cesium.Texture|null>}
 */
HeightMapGenerator.prototype.generateHeightMap = async function (
  rectangle,
  textureSize = 1024,
) {
  if (this._destroyed) return null;
  if (!(rectangle instanceof Rectangle)) {
    throw new TypeError("rectangle must be a Cesium.Rectangle instance");
  }
  if (!Number.isInteger(textureSize) || textureSize <= 0) {
    throw new RangeError("textureSize must be a positive integer");
  }

  this._log("=== 开始生成高度图 ===");
  this._log("矩形范围:", rectangle);
  this._log("纹理大小:", textureSize);

  this._destroyResources();
  this._cachedHeightMapData = null;

  const generationToken = ++this._generationToken;
  const level = await this._getBestAvailableLevel(rectangle, generationToken);
  if (!this._isGenerationActive(generationToken)) return null;
  if (!Number.isInteger(level) || level < 0) return null;
  this._log("最高可用等级:", level);

  const tiles = this._getTilesInRectangle(rectangle, level);
  this._log("相交瓦片数量:", tiles.length);
  if (tiles.length === 0) {
    throw new Error("指定区域内没有可用的地形瓦片");
  }

  this._createHeightMapResources(textureSize);
  const tilesData = await this._loadAllTilesDataParallel(tiles, generationToken);
  if (!this._isGenerationActive(generationToken)) return null;
  if (!tilesData) return null;
  this._log("成功加载瓦片数据数量:", tilesData.length);
  if (tilesData.length === 0) {
    this._destroyResources();
    throw new Error("无法加载任何地形瓦片数据");
  }

  this._createDrawCommandsForTilesData(tilesData, rectangle);
  if (!this._isGenerationActive(generationToken)) return null;
  this._renderHeightMap();

  this._log("=== 高度图生成完成 ===");
  return this._heightMapTexture;
};

/**
 * 读取最近一次生成的高度图数据。
 * @returns {Object|null} 高度图数据
 */
HeightMapGenerator.prototype.readHeightMapData = function () {
  if (this._destroyed || !this._heightMapTexture || !this._heightMapFramebuffer) {
    return null;
  }
  if (this._cachedHeightMapData) return this._cachedHeightMapData;

  const width = this._heightMapTexture.width;
  const height = this._heightMapTexture.height;
  const pixels = this._context.readPixels({
    x: 0,
    y: 0,
    width,
    height,
    framebuffer: this._heightMapFramebuffer,
  });
  const rawData = new Float32Array(pixels.buffer);

  let rawMin = Infinity;
  let rawMax = -Infinity;
  let nonZeroCount = 0;
  for (let index = 0; index < rawData.length; index += 4) {
    const value = rawData[index];
    if (value !== 0) {
      nonZeroCount++;
      rawMin = Math.min(rawMin, value);
      rawMax = Math.max(rawMax, value);
    }
  }

  this._log("=== 离屏渲染高度数据调试 ===");
  this._log("离屏渲染数据统计:");
  this._log("  - 非零像素数量:", nonZeroCount);
  this._log("  - 归一化高度范围:", rawMin.toFixed(4), "~", rawMax.toFixed(4));
  this._log(
    "  - 全局实际高度范围:",
    this._globalMinHeight.toFixed(2),
    "m ~",
    this._globalMaxHeight.toFixed(2),
    "m",
  );

  this._cachedHeightMapData = {
    width,
    height,
    data: rawData,
    actualMinHeight: this._globalMinHeight,
    actualMaxHeight: this._globalMaxHeight,
  };
  return this._cachedHeightMapData;
};

/**
 * 根据经纬度坐标采样高度值。
 * @param {number} longitude - 经度（弧度）
 * @param {number} latitude - 纬度（弧度）
 * @returns {number|null} 高度值（米）
 */
HeightMapGenerator.prototype.sampleHeight = function (longitude, latitude) {
  if (this._destroyed) return null;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    this._warn("sampleHeight: 无效的经纬度参数");
    return null;
  }

  const rectangle = this._actualTargetRectangle;
  const heightMapData = this.readHeightMapData();
  if (!rectangle || !heightMapData) {
    this._warn("高度图未生成或目标区域未设置");
    return null;
  }
  if (
    longitude < rectangle.west ||
    longitude > rectangle.east ||
    latitude < rectangle.south ||
    latitude > rectangle.north
  ) {
    return null;
  }

  const longitudeRange = rectangle.east - rectangle.west;
  const latitudeRange = rectangle.north - rectangle.south;
  const u = longitudeRange === 0 ? 0 : (longitude - rectangle.west) / longitudeRange;
  const v = latitudeRange === 0 ? 0 : (latitude - rectangle.south) / latitudeRange;
  const x = Math.floor(u * (heightMapData.width - 1));
  const y = Math.floor(v * (heightMapData.height - 1));
  const pixelIndex = (y * heightMapData.width + x) * 4;
  const normalizedHeight = heightMapData.data[pixelIndex];

  return (
    normalizedHeight *
      (heightMapData.actualMaxHeight - heightMapData.actualMinHeight) +
    heightMapData.actualMinHeight
  );
};

/**
 * 查询对象是否已销毁。
 * @returns {boolean}
 */
HeightMapGenerator.prototype.isDestroyed = function () {
  return this._destroyed;
};

/**
 * 销毁所有 GPU 和 CPU 资源。
 */
HeightMapGenerator.prototype.destroy = function () {
  if (this._destroyed) return;
  this._destroyed = true;
  this._generationToken++;
  this._cachedHeightMapData = null;
  this._destroyResources();

  if (this._sharedShaderProgram) {
    this._sharedShaderProgram.destroy();
    this._sharedShaderProgram = null;
  }

  this._tileNDCRanges = [];
  this._actualTargetRectangle = null;
  this._terrainProvider = null;
  this._context = null;
  this._scene = null;
  this._viewer = null;
};

/* ===========================================================================
 * 内部方法
 * =========================================================================== */

HeightMapGenerator.prototype._loadAllTilesDataParallel = async function (
  tiles,
  generationToken,
) {
  this._log("开始并行加载所有瓦片数据...");
  const terrainProvider = this._terrainProvider;
  if (!terrainProvider || !this._isGenerationActive(generationToken)) return null;
  const promises = tiles.map((tile) =>
    terrainProvider
      .requestTileGeometry(tile.x, tile.y, tile.level)
      .then((terrainData) => (terrainData ? { tile, terrainData } : null))
      .catch((error) => {
        if (!this._isGenerationActive(generationToken)) return null;
        this._error(
          `加载瓦片 (${tile.x}, ${tile.y}, ${tile.level}) 失败:`,
          error,
        );
        return null;
      }),
  );

  const tilesData = (await Promise.all(promises)).filter(Boolean);
  if (!this._isGenerationActive(generationToken)) return null;
  let globalMinHeight = Infinity;
  let globalMaxHeight = -Infinity;

  tilesData.forEach(({ tile, terrainData }) => {
    if (
      terrainData._minimumHeight !== undefined &&
      terrainData._maximumHeight !== undefined
    ) {
      this._log(
        `瓦片 (${tile.x}, ${tile.y}) 高度范围: ${terrainData._minimumHeight.toFixed(2)}m ~ ${terrainData._maximumHeight.toFixed(2)}m`,
      );
      globalMinHeight = Math.min(globalMinHeight, terrainData._minimumHeight);
      globalMaxHeight = Math.max(globalMaxHeight, terrainData._maximumHeight);
    }
  });

  if (!Number.isFinite(globalMinHeight) || !Number.isFinite(globalMaxHeight)) {
    this._warn("无法获取有效的高度范围，使用默认值");
    globalMinHeight = 0;
    globalMaxHeight = 1000;
  }

  this._globalMinHeight = globalMinHeight;
  this._globalMaxHeight = globalMaxHeight;
  this._globalHeightRange = globalMaxHeight - globalMinHeight;
  this._log(
    "全局高度范围:",
    globalMinHeight.toFixed(2),
    "m ~",
    globalMaxHeight.toFixed(2),
    "m",
  );
  return tilesData;
};

HeightMapGenerator.prototype._createDrawCommandsForTilesData = function (
  tilesData,
  rectangle,
) {
  this._drawCommands = [];
  this._tileNDCRanges = [];
  this._actualTargetRectangle = rectangle;

  const tilingScheme = this._terrainProvider.tilingScheme;
  let actualWest = Infinity;
  let actualEast = -Infinity;
  let actualSouth = Infinity;
  let actualNorth = -Infinity;

  tilesData.forEach(({ tile }) => {
    const tileRectangle = tilingScheme.tileXYToRectangle(tile.x, tile.y, tile.level);
    actualWest = Math.min(actualWest, tileRectangle.west);
    actualEast = Math.max(actualEast, tileRectangle.east);
    actualSouth = Math.min(actualSouth, tileRectangle.south);
    actualNorth = Math.max(actualNorth, tileRectangle.north);
  });

  const actualRectangle = new Rectangle(
    actualWest,
    actualSouth,
    actualEast,
    actualNorth,
  );
  this._log("\n=== 区域对比 ===");
  this._log("原始研究区域 (rectangle):", this._rectangleToDegrees(rectangle));
  this._log(
    "瓦片实际覆盖范围 (actualRectangle):",
    this._rectangleToDegrees(actualRectangle),
  );

  let fullyInside = 0;
  let partiallyInside = 0;
  let fullyOutside = 0;
  tilesData.forEach(({ tile }) => {
    const tileRectangle = tilingScheme.tileXYToRectangle(tile.x, tile.y, tile.level);
    const overlapWest = Math.max(tileRectangle.west, rectangle.west);
    const overlapEast = Math.min(tileRectangle.east, rectangle.east);
    const overlapSouth = Math.max(tileRectangle.south, rectangle.south);
    const overlapNorth = Math.min(tileRectangle.north, rectangle.north);
    const hasOverlap = overlapWest < overlapEast && overlapSouth < overlapNorth;

    if (!hasOverlap) {
      fullyOutside++;
      return;
    }

    const tileArea =
      (tileRectangle.east - tileRectangle.west) *
      (tileRectangle.north - tileRectangle.south);
    const overlapArea =
      (overlapEast - overlapWest) * (overlapNorth - overlapSouth);
    const overlapRatio = overlapArea / tileArea;
    if (overlapRatio > 0.99) fullyInside++;
    else partiallyInside++;
  });

  this._log(
    `统计: 完全在内=${fullyInside}, 部分在内=${partiallyInside}, 完全在外=${fullyOutside}`,
  );

  let actualMinHeight = Infinity;
  let actualMaxHeight = -Infinity;
  tilesData.forEach(({ tile, terrainData }) => {
    try {
      const result = this._createDrawCommandForTile(terrainData, tile, rectangle);
      if (!result?.drawCommand) return;

      this._drawCommands.push(result.drawCommand);
      this._tileNDCRanges.push(result.ndcRange);
      if (result.heightRange) {
        actualMinHeight = Math.min(actualMinHeight, result.heightRange.min);
        actualMaxHeight = Math.max(actualMaxHeight, result.heightRange.max);
      }
    } catch (error) {
      this._error(
        `创建 DrawCommand 失败 (${tile.x}, ${tile.y}, ${tile.level}):`,
        error,
      );
    }
  });

  if (Number.isFinite(actualMinHeight) && Number.isFinite(actualMaxHeight)) {
    this._globalMinHeight = actualMinHeight;
    this._globalMaxHeight = actualMaxHeight;
    this._globalHeightRange = actualMaxHeight - actualMinHeight;
  }

  this._log(
    "实际顶点高度范围:",
    this._globalMinHeight.toFixed(2),
    "m ~",
    this._globalMaxHeight.toFixed(2),
    "m",
  );
  this._logNDCSummary();
  this._log(`成功创建 ${this._drawCommands.length} 个 DrawCommand`);
};

HeightMapGenerator.prototype._getBestAvailableLevel = async function (
  rectangle,
  generationToken,
) {
  const terrainProvider = this._terrainProvider;
  if (!terrainProvider || !this._isGenerationActive(generationToken)) return null;
  const availability = terrainProvider.availability;
  if (
    availability &&
    typeof availability.computeBestAvailableLevelOverRectangle === "function"
  ) {
    try {
      const level = availability.computeBestAvailableLevelOverRectangle(rectangle);
      if (level >= 0) return level;
    } catch (error) {
      this._warn("computeBestAvailableLevelOverRectangle 调用失败:", error);
    }
  }

  if (
    availability &&
    typeof availability.computeMaximumLevelAtPosition === "function"
  ) {
    try {
      const level = availability.computeMaximumLevelAtPosition(Rectangle.center(rectangle));
      if (level >= 0) return level;
    } catch (error) {
      this._warn("computeMaximumLevelAtPosition 调用失败:", error);
    }
  }

  const tilingScheme = terrainProvider.tilingScheme;
  const center = Rectangle.center(rectangle);
  this._log("开始测试请求以确定最高等级...");
  for (let testLevel = 15; testLevel >= 8; testLevel--) {
    if (!this._isGenerationActive(generationToken)) return null;
    const tileXY = tilingScheme.positionToTileXY(center, testLevel);
    if (!tileXY) continue;
    try {
      const terrainData = await terrainProvider.requestTileGeometry(
        tileXY.x,
        tileXY.y,
        testLevel,
      );
      if (!this._isGenerationActive(generationToken)) return null;
      if (terrainData) return testLevel;
    } catch (_) {
      if (!this._isGenerationActive(generationToken)) return null;
      // 当前等级不可用时继续尝试更低等级。
    }
  }

  const defaultLevel = 11;
  this._warn("无法确定最高等级，使用默认等级:", defaultLevel);
  return defaultLevel;
};

HeightMapGenerator.prototype._isGenerationActive = function (generationToken) {
  return !this._destroyed && generationToken === this._generationToken;
};

HeightMapGenerator.prototype._getTilesInRectangle = function (rectangle, level) {
  const tilingScheme = this._terrainProvider.tilingScheme;
  const northwest = tilingScheme.positionToTileXY(Rectangle.northwest(rectangle), level);
  const northeast = tilingScheme.positionToTileXY(Rectangle.northeast(rectangle), level);
  const southwest = tilingScheme.positionToTileXY(Rectangle.southwest(rectangle), level);
  const southeast = tilingScheme.positionToTileXY(Rectangle.southeast(rectangle), level);

  if (!northwest || !northeast || !southwest || !southeast) {
    this._warn("无法计算瓦片范围");
    return [];
  }

  const minX = Math.min(northwest.x, southwest.x);
  const maxX = Math.max(northeast.x, southeast.x);
  const minY = Math.min(northwest.y, northeast.y);
  const maxY = Math.max(southwest.y, southeast.y);
  const tiles = [];

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) tiles.push({ x, y, level });
  }
  tiles.reverse();
  return tiles;
};

HeightMapGenerator.prototype._createHeightMapResources = function (textureSize) {
  this._heightMapTexture = new Texture({
    context: this._context,
    width: textureSize,
    height: textureSize,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: PixelDatatype.FLOAT,
    sampler: new Sampler({
      minificationFilter: TextureMinificationFilter.NEAREST,
      magnificationFilter: TextureMagnificationFilter.NEAREST,
    }),
  });
  this._depthTexture = new Texture({
    context: this._context,
    width: textureSize,
    height: textureSize,
    pixelFormat: PixelFormat.DEPTH_COMPONENT,
    pixelDatatype: PixelDatatype.UNSIGNED_INT,
  });
  this._heightMapFramebuffer = new Framebuffer({
    context: this._context,
    colorTextures: [this._heightMapTexture],
    depthTexture: this._depthTexture,
    destroyAttachments: false,
  });
};

HeightMapGenerator.prototype._createDrawCommandForTile = function (
  terrainData,
  tile,
  rectangle,
) {
  const tileRectangle = this._terrainProvider.tilingScheme.tileXYToRectangle(
    tile.x,
    tile.y,
    tile.level,
  );
  const result = this._extractVerticesAndIndices(
    terrainData,
    tile,
    tileRectangle,
    rectangle,
  );
  if (!result?.vertices?.length || !result.indices?.length) return null;

  let vertexBuffer;
  let indexBuffer;
  let vertexArray;
  try {
    vertexBuffer = Buffer.createVertexBuffer({
      context: this._context,
      typedArray: new Float32Array(result.vertices),
      usage: BufferUsage.STATIC_DRAW,
    });
    indexBuffer = Buffer.createIndexBuffer({
      context: this._context,
      typedArray: new Uint16Array(result.indices),
      usage: BufferUsage.STATIC_DRAW,
      indexDatatype: IndexDatatype.UNSIGNED_SHORT,
    });
    vertexArray = new VertexArray({
      context: this._context,
      attributes: [
        {
          index: 0,
          vertexBuffer,
          componentsPerAttribute: 3,
          componentDatatype: ComponentDatatype.FLOAT,
          offsetInBytes: 0,
          strideInBytes: 12,
        },
      ],
      indexBuffer,
    });
    const renderState = RenderState.fromCache({
      depthTest: { enabled: false },
      depthMask: false,
      blending: { enabled: false },
      cull: { enabled: false },
    });
    const drawCommand = new DrawCommand({
      vertexArray,
      shaderProgram: this._getSharedShaderProgram(),
      renderState,
      framebuffer: this._heightMapFramebuffer,
      uniformMap: {},
      pass: Pass.OPAQUE,
    });
    return { drawCommand, ndcRange: result.ndcRange, heightRange: result.heightRange };
  } catch (error) {
    if (vertexArray) vertexArray.destroy();
    else {
      vertexBuffer?.destroy();
      indexBuffer?.destroy();
    }
    throw error;
  }
};

HeightMapGenerator.prototype._getSharedShaderProgram = function () {
  if (!this._sharedShaderProgram) {
    this._sharedShaderProgram = this._createShaderProgramForTile();
  }
  return this._sharedShaderProgram;
};

HeightMapGenerator.prototype._createShaderProgramForTile = function () {
  return ShaderProgram.fromCache({
    context: this._context,
    vertexShaderSource: `
      in vec3 position;
      out float v_height;

      void main() {
        gl_Position = vec4(position.xy, 1.0, 1.0);
        v_height = position.z;
      }
    `,
    fragmentShaderSource: `
      in float v_height;

      void main() {
        out_FragColor = vec4(v_height, v_height, v_height, 1.0);
      }
    `,
    attributeLocations: { position: 0 },
  });
};

HeightMapGenerator.prototype._renderHeightMap = function () {
  this._log("开始渲染高度图, DrawCommand 数量:", this._drawCommands.length);
  const clearCommand = new ClearCommand({
    color: new Color(0.0, 0.0, 0.0, 0.0),
    depth: 1.0,
    framebuffer: this._heightMapFramebuffer,
    pass: Pass.OPAQUE,
  });
  clearCommand.execute(this._context);

  const textureSize = this._heightMapTexture.width;
  const passState = new PassState(this._context);
  passState.viewport = new BoundingRectangle(0, 0, textureSize, textureSize);
  this._drawCommands.forEach((drawCommand, index) => {
    try {
      drawCommand.execute(this._context, passState);
    } catch (error) {
      this._error(`DrawCommand ${index + 1} 执行失败:`, error);
    }
  });
};

HeightMapGenerator.prototype._extractVerticesAndIndices = function (
  terrainData,
  tile,
  tileRectangle,
  targetRectangle,
) {
  try {
    const uValues = terrainData._uValues;
    const vValues = terrainData._vValues;
    const heightValues = terrainData._heightValues;
    if (!uValues || !vValues || !heightValues) {
      this._error(`瓦片 (${tile.x}, ${tile.y}) 缺少顶点数据`);
      return { vertices: [], indices: [], ndcRange: null };
    }

    const vertices = [];
    const vertexCount = uValues.length;
    const quantizedRange = 32767;
    const tileMinHeight = terrainData._minimumHeight || 0;
    const tileMaxHeight = terrainData._maximumHeight || 1000;
    const targetWidth = targetRectangle.east - targetRectangle.west;
    const targetHeight = targetRectangle.north - targetRectangle.south;
    const globalHeightRange =
      this._globalHeightRange || this._globalMaxHeight - this._globalMinHeight;
    let minHeight = Infinity;
    let maxHeight = -Infinity;

    for (let index = 0; index < vertexCount; index++) {
      const u = uValues[index] / quantizedRange;
      const v = vValues[index] / quantizedRange;
      const normalizedTerrainHeight = heightValues[index] / quantizedRange;
      const longitude =
        tileRectangle.west + u * (tileRectangle.east - tileRectangle.west);
      const latitude =
        tileRectangle.south + v * (tileRectangle.north - tileRectangle.south);
      const tileHeight =
        tileMinHeight + normalizedTerrainHeight * (tileMaxHeight - tileMinHeight);
      const normalizedHeight =
        globalHeightRange > 0
          ? (tileHeight - this._globalMinHeight) / globalHeightRange
          : 0.5;
      const ndcX =
        targetWidth === 0
          ? 0
          : ((longitude - targetRectangle.west) / targetWidth) * 2.0 - 1.0;
      const ndcY =
        targetHeight === 0
          ? 0
          : ((latitude - targetRectangle.south) / targetHeight) * 2.0 - 1.0;

      vertices.push(ndcX, ndcY, normalizedHeight);
      minHeight = Math.min(minHeight, tileHeight);
      maxHeight = Math.max(maxHeight, tileHeight);
    }

    return {
      vertices,
      indices: terrainData._indices ? Array.from(terrainData._indices) : [],
      ndcRange: this._calculateNDCRange(vertices),
      heightRange: { min: minHeight, max: maxHeight },
    };
  } catch (error) {
    this._error(`瓦片 (${tile.x}, ${tile.y}) 提取顶点数据失败:`, error);
    return { vertices: [], indices: [], ndcRange: null };
  }
};

HeightMapGenerator.prototype._calculateNDCRange = function (vertices) {
  if (!vertices?.length) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < vertices.length; index += 3) {
    minX = Math.min(minX, vertices[index]);
    maxX = Math.max(maxX, vertices[index]);
    minY = Math.min(minY, vertices[index + 1]);
    maxY = Math.max(maxY, vertices[index + 1]);
  }
  return { minX, maxX, minY, maxY };
};

HeightMapGenerator.prototype._logNDCSummary = function () {
  if (!this._tileNDCRanges.length) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  this._tileNDCRanges.forEach((range) => {
    if (!range) return;
    minX = Math.min(minX, range.minX);
    maxX = Math.max(maxX, range.maxX);
    minY = Math.min(minY, range.minY);
    maxY = Math.max(maxY, range.maxY);
  });
  this._log(
    `总体 NDC 覆盖范围: X[${minX.toFixed(4)}, ${maxX.toFixed(4)}] Y[${minY.toFixed(4)}, ${maxY.toFixed(4)}]`,
  );
};

HeightMapGenerator.prototype._rectangleToDegrees = function (rectangle) {
  return {
    west: CesiumMath.toDegrees(rectangle.west).toFixed(6),
    east: CesiumMath.toDegrees(rectangle.east).toFixed(6),
    south: CesiumMath.toDegrees(rectangle.south).toFixed(6),
    north: CesiumMath.toDegrees(rectangle.north).toFixed(6),
  };
};

HeightMapGenerator.prototype._destroyResources = function () {
  this._drawCommands.forEach((command) => {
    const vertexArray = command.vertexArray;
    if (
      vertexArray &&
      typeof vertexArray.destroy === "function" &&
      (!vertexArray.isDestroyed || !vertexArray.isDestroyed())
    ) {
      vertexArray.destroy();
    }
  });
  this._drawCommands = [];

  if (this._heightMapFramebuffer) {
    this._heightMapFramebuffer.destroy();
    this._heightMapFramebuffer = null;
  }
  if (this._heightMapTexture) {
    this._heightMapTexture.destroy();
    this._heightMapTexture = null;
  }
  if (this._depthTexture) {
    this._depthTexture.destroy();
    this._depthTexture = null;
  }
};

export default HeightMapGenerator;
