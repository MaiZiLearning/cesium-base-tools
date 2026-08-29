/**
 * 将离屏生成的高度图绘制到 Cesium 场景中。
 */
import {
  Cartographic,
  Color,
  EllipsoidSurfaceAppearance,
  GeometryInstance,
  GroundPrimitive,
  HeadingPitchRange,
  ImageMaterialProperty,
  Math as CesiumMath,
  Material,
  Rectangle,
  RectangleGeometry,
  Texture,
} from "cesium";

/**
 * @param {Cesium.Viewer} viewer - Cesium Viewer 实例
 * @param {Object} [heightMapGenerator] - 高度图生成器
 */
function HeightMapVisualizer(viewer, heightMapGenerator) {
  if (!viewer || !viewer.scene) {
    throw new TypeError("viewer must be a Cesium Viewer instance");
  }
  if (
    !heightMapGenerator ||
    typeof heightMapGenerator.readHeightMapData !== "function"
  ) {
    throw new TypeError("heightMapGenerator must provide readHeightMapData");
  }

  this._viewer = viewer;
  this._heightMapGenerator = heightMapGenerator;
  this._entity = null;
  this._groundPrimitive = null;
  this._rectangle = null;
  this._alpha = 0.8;
  this._destroyed = false;
}

/* ===========================================================================
 * 公开 API
 * ===========================================================================
 */

/**
 * 显示高度图。
 * @param {Cesium.Rectangle} rectangle - 覆盖范围
 * @param {Cesium.Texture} heightMapTexture - 高度图纹理
 * @param {Object} [options] - 显示选项
 * @param {number} [options.alpha=0.8] - 透明度
 * @param {boolean} [options.clampToGround=false] - 是否贴地显示
 * @returns {Cesium.Entity|Cesium.GroundPrimitive|null}
 */
HeightMapVisualizer.prototype.show = function (
  rectangle,
  heightMapTexture,
  options,
) {
  if (this._destroyed) return null;
  this._validateDisplayArguments(rectangle, heightMapTexture, options);
  const settings = options ?? {};
  return settings.clampToGround
    ? this._showAsGroundPrimitive(rectangle, heightMapTexture, settings)
    : this._showAsEntity(rectangle, heightMapTexture, settings);
};

/**
 * 隐藏高度图。
 */
HeightMapVisualizer.prototype.hide = function () {
  if (this._destroyed) return;
  if (this._entity) this._entity.show = false;
  if (this._groundPrimitive) this._groundPrimitive.show = false;
};

/**
 * 显示高度图。
 */
HeightMapVisualizer.prototype.showVisualization = function () {
  if (this._destroyed) return;
  if (this._entity) this._entity.show = true;
  if (this._groundPrimitive) this._groundPrimitive.show = true;
};

/**
 * 更新透明度。
 * @param {number} alpha - 0 到 1 之间的透明度
 */
HeightMapVisualizer.prototype.setAlpha = function (alpha) {
  if (this._destroyed) return;
  this._alpha = this._validateAlpha(alpha);
  if (this._entity?.rectangle?.material) {
    this._entity.rectangle.material.color = Color.WHITE.withAlpha(this._alpha);
  }

  const uniforms = this._groundPrimitive?.appearance?.material?.uniforms;
  if (uniforms) uniforms.color = Color.WHITE.withAlpha(this._alpha);
};

/**
 * 飞到高度图位置。
 * @param {number} [duration=2] - 飞行时长（秒）
 */
HeightMapVisualizer.prototype.flyTo = function (duration = 2.0) {
  if (this._destroyed) return;
  if (!Number.isFinite(duration) || duration < 0) {
    throw new RangeError("duration must be a finite non-negative number");
  }

  if (this._entity) {
    this._viewer.flyTo(this._entity, {
      duration,
      offset: new HeadingPitchRange(0, CesiumMath.toRadians(-45), 5000),
    });
    return;
  }

  if (this._groundPrimitive && this._rectangle) {
    const center = Rectangle.center(this._rectangle);
    const cartographic = new Cartographic(
      center.longitude,
      center.latitude,
      5000,
    );
    this._viewer.camera.flyTo({
      destination: Cartographic.toCartesian(cartographic),
      orientation: {
        heading: 0,
        pitch: CesiumMath.toRadians(-45),
        roll: 0,
      },
      duration,
    });
  }
};

/**
 * 查询对象是否已销毁。
 * @returns {boolean}
 */
HeightMapVisualizer.prototype.isDestroyed = function () {
  return this._destroyed;
};

/**
 * 销毁场景图层和对象引用。
 */
HeightMapVisualizer.prototype.destroy = function () {
  if (this._destroyed) return;
  this._destroyed = true;
  this._removeVisualization();
  this._heightMapGenerator = null;
  this._viewer = null;
  this._rectangle = null;
};

/* ===========================================================================
 * 内部方法
 * ===========================================================================
 */

HeightMapVisualizer.prototype._showAsGroundPrimitive = function (
  rectangle,
  heightMapTexture,
  options,
) {
  this._removeVisualization();
  this._rectangle = rectangle;
  this._alpha = this._validateAlpha(options.alpha ?? 0.8);
  const canvas = this._textureToCanvas(heightMapTexture);
  const instance = new GeometryInstance({
    geometry: new RectangleGeometry({
      rectangle,
      vertexFormat: EllipsoidSurfaceAppearance.VERTEX_FORMAT,
    }),
    id: "heightmap-ground-primitive",
  });

  this._groundPrimitive = this._viewer.scene.groundPrimitives.add(
    new GroundPrimitive({
      geometryInstances: instance,
      appearance: new EllipsoidSurfaceAppearance({
        material: new Material({
          fabric: {
            type: "Image",
            uniforms: {
              image: canvas,
              color: Color.WHITE.withAlpha(this._alpha),
            },
          },
        }),
        aboveGround: false,
        translucent: true,
      }),
      show: true,
      asynchronous: false,
    }),
  );
  return this._groundPrimitive;
};

HeightMapVisualizer.prototype._showAsEntity = function (
  rectangle,
  heightMapTexture,
  options,
) {
  this._removeVisualization();
  this._rectangle = rectangle;
  this._alpha = this._validateAlpha(options.alpha ?? 0.8);
  const canvas = this._textureToCanvas(heightMapTexture);

  this._entity = this._viewer.entities.add({
    name: "离屏渲染高度图",
    show: true,
    rectangle: {
      coordinates: rectangle,
      material: new ImageMaterialProperty({
        image: canvas,
        color: Color.WHITE.withAlpha(this._alpha),
        transparent: true,
      }),
      height: 200,
      outline: true,
      outlineColor: Color.YELLOW,
      outlineWidth: 2,
    },
  });
  return this._entity;
};

HeightMapVisualizer.prototype._textureToCanvas = function (heightMapTexture) {
  if (!this._heightMapGenerator || this._heightMapGenerator.isDestroyed?.()) {
    throw new TypeError("heightMapGenerator is required to read height map data");
  }
  const heightMapData = this._heightMapGenerator.readHeightMapData();
  if (!heightMapData) {
    throw new Error("height map data is not available");
  }

  const canvas = document.createElement("canvas");
  canvas.width = heightMapData.width;
  canvas.height = heightMapData.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create a 2D canvas context");

  const imageData = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < heightMapData.height; y++) {
    for (let x = 0; x < heightMapData.width; x++) {
      const sourceIndex = (y * heightMapData.width + x) * 4;
      const targetIndex =
        ((heightMapData.height - 1 - y) * heightMapData.width + x) * 4;
      const normalizedHeight = Math.max(
        0,
        Math.min(1, heightMapData.data[sourceIndex] ?? 0),
      );
      const gray = Math.floor(normalizedHeight * 255);
      imageData.data[targetIndex] = gray;
      imageData.data[targetIndex + 1] = gray;
      imageData.data[targetIndex + 2] = gray;
      imageData.data[targetIndex + 3] = 255;
    }
  }
  context.putImageData(imageData, 0, 0);
  return canvas;
};

HeightMapVisualizer.prototype._removeVisualization = function () {
  if (!this._viewer || this._viewer.isDestroyed?.()) {
    this._entity = null;
    this._groundPrimitive = null;
    this._rectangle = null;
    return;
  }
  if (this._entity) {
    this._viewer.entities.remove(this._entity);
    this._entity = null;
  }
  if (this._groundPrimitive) {
    this._viewer.scene.groundPrimitives.remove(this._groundPrimitive);
    this._groundPrimitive = null;
  }
  this._rectangle = null;
};

HeightMapVisualizer.prototype._validateDisplayArguments = function (
  rectangle,
  heightMapTexture,
  options,
) {
  if (!(rectangle instanceof Rectangle)) {
    throw new TypeError("rectangle must be a Cesium.Rectangle instance");
  }
  if (!(heightMapTexture instanceof Texture)) {
    throw new TypeError("heightMapTexture must be a Cesium.Texture instance");
  }
  if (heightMapTexture.isDestroyed?.()) {
    throw new TypeError("heightMapTexture must not be destroyed");
  }
  if (options?.alpha !== undefined) this._validateAlpha(options.alpha);
  if (
    options?.clampToGround !== undefined &&
    typeof options.clampToGround !== "boolean"
  ) {
    throw new TypeError("clampToGround must be a boolean");
  }
};

HeightMapVisualizer.prototype._validateAlpha = function (alpha) {
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new RangeError("alpha must be a number between 0 and 1");
  }
  return alpha;
};

export default HeightMapVisualizer;
