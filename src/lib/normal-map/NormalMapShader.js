/**
 * @Description: 从场景深度纹理重建视空间法线的后处理着色器
 *
 * 从 SSRShaders.js 的 SSRShader 中提取 getViewPosition、getViewNormal
 * 和深度读取部分，仅保留法线重建与 RGB 编码，不包含 SSR 反射计算。
 * 法线通过相邻像素的视空间位置叉乘获得：
 * 1. 使用 depthTexture 和 Cesium 内置矩阵还原中心及四邻域位置
 * 2. 由相邻位置差计算切线，再叉乘得到法线
 * 3. 将 [-1, 1] 法线编码为 [0, 1] 颜色显示
 */
export const NormalMapShader = `
uniform sampler2D depthTexture;

in vec2 v_textureCoordinates;
out vec4 vFragColor;

vec3 getViewPosition(vec2 uv, float depth) {
  vec2 windowCoord = uv * czm_viewport.zw;
  vec4 eyeCoordinate = czm_windowToEyeCoordinates(windowCoord, depth);
  return eyeCoordinate.xyz / eyeCoordinate.w;
}

vec3 getViewNormal(vec2 uv, vec3 viewPos) {
  vec2 texelSize = 1.0 / czm_viewport.zw;

  float depthC = czm_unpackDepth(texture(depthTexture, uv));
  float depthL = czm_unpackDepth(texture(depthTexture, uv + vec2(-texelSize.x, 0.0)));
  float depthR = czm_unpackDepth(texture(depthTexture, uv + vec2(texelSize.x, 0.0)));
  float depthU = czm_unpackDepth(texture(depthTexture, uv + vec2(0.0, texelSize.y)));
  float depthD = czm_unpackDepth(texture(depthTexture, uv + vec2(0.0, -texelSize.y)));

  // 邻域为天空时使用中心深度，避免边缘法线翻转。
  if (depthL == 0.0 || depthL > 0.999999) depthL = depthC;
  if (depthR == 0.0 || depthR > 0.999999) depthR = depthC;
  if (depthU == 0.0 || depthU > 0.999999) depthU = depthC;
  if (depthD == 0.0 || depthD > 0.999999) depthD = depthC;

  vec3 posL = getViewPosition(uv + vec2(-texelSize.x, 0.0), depthL);
  vec3 posR = getViewPosition(uv + vec2(texelSize.x, 0.0), depthR);
  vec3 posU = getViewPosition(uv + vec2(0.0, texelSize.y), depthU);
  vec3 posD = getViewPosition(uv + vec2(0.0, -texelSize.y), depthD);

  vec3 normal = normalize(cross(posR - posL, posD - posU));
  if (dot(normal, viewPos) > 0.0) normal = -normal;
  return normal;
}

void main() {
  float depth = czm_unpackDepth(texture(depthTexture, v_textureCoordinates));
  bool isSky = depth == 0.0 || depth > 0.999999;
  if (isSky) {
    vFragColor = vec4(0.035, 0.055, 0.1, 1.0);
    return;
  }

  vec3 viewPos = getViewPosition(v_textureCoordinates, depth);
  vec3 normal = getViewNormal(v_textureCoordinates, viewPos);
  vFragColor = vec4(normal * 0.5 + 0.5, 1.0);
}
`;
