"use client";

import { useEffect, useRef } from "react";

type ZoomCanvasProps = {
  images: string[];
  onReady?: () => void;
  orientation?: number | null;
  rawOrientation?: number | null;
  onZoomChange?: (zoomExponent: number, zoomRange: { min: number; max: number }) => void;
  enabled?: boolean;
  isMobile?: boolean;
};

type Layer = {
  scale: number;
  src: string;
};

const BASE_RECT_WIDTH = 4;
const BASE_RECT_HEIGHT = 3;
const SCALE_FACTOR = 2;
const BASE_SCALE = 1;
const DEFAULT_DPR = 1;
const ZOOM_EASING = 0.08; // Reduced for smoother zoom (was 0.1)
const ZOOM_TOLERANCE = 0.001;
const WHEEL_SENSITIVITY = 0.012;
// Removed fixed INNER_FIT_EXPONENT - now calculated dynamically based on aspect ratio
const LINE_TO_PIXEL_FACTOR = 16;
const PAGE_TO_PIXEL_FACTOR = 800;
const MAX_WHEEL_DELTA = 30;
const WHEEL_NORMALIZATION_FACTOR = 80;
const WHEEL_DAMPING = 0.9;
const WHEEL_EPSILON = 0.0002;
const CLEAR_COLOR = {
  r: 0.02,
  g: 0.02,
  b: 0.05,
  a: 1,
} as const;
const POSITION_COMPONENTS = 2;
const TEXCOORD_COMPONENTS = 2;
const FLOAT_SIZE = Float32Array.BYTES_PER_ELEMENT;
const VERTEX_STRIDE = (POSITION_COMPONENTS + TEXCOORD_COMPONENTS) * FLOAT_SIZE;
const POSITION_OFFSET = 0;
const TEXCOORD_OFFSET = POSITION_COMPONENTS * FLOAT_SIZE;
const RECTANGLE_VERTEX_COUNT = 4;
const TEXTURE_UNIT_INDEX = 0;
const FLIP_TEXTURE_COORDINATES = 0;
const EDGE_FEATHER_WIDTH = 0.12;
const OUTER_EDGE_FEATHER = 0;
const ORIENTATION_DEAD_ZONE = 0;
const ORIENTATION_ZOOM_SPEED = 0.04;
const MIN_ZOOM_SPEED = 0.3;
const FRAME_TIME_FACTOR = 0.016;
const SNAP_BACK_SPEED = 0.25;
const DEGREES_IN_HALF_CIRCLE = 180;
const DEG_TO_RAD = Math.PI / DEGREES_IN_HALF_CIRCLE;

const vertexSource = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;

  uniform float u_scale;
  uniform float u_zoom;
  uniform float u_rotation;
  uniform vec2 u_canvasSize;
  uniform vec2 u_baseSize;

  varying vec2 v_texCoord;

  void main() {
    vec2 scaled = (a_position * u_scale) / u_zoom;

    // Rotate in world space FIRST (before aspect correction) to prevent warping
    // This gives us a true 2D rotation of the rectangle
    float cosR = cos(u_rotation);
    float sinR = sin(u_rotation);
    vec2 rotated = vec2(
      scaled.x * cosR - scaled.y * sinR,
      scaled.x * sinR + scaled.y * cosR
    );

    // Now normalize and apply aspect correction
    vec2 normalized = vec2(
      rotated.x / (u_baseSize.x * 0.5),
      rotated.y / (u_baseSize.y * 0.5)
    );

    float canvasAspect = u_canvasSize.x / u_canvasSize.y;
    float sceneAspect = u_baseSize.x / u_baseSize.y;

    if (canvasAspect > sceneAspect) {
      float stretch = canvasAspect / sceneAspect;
      normalized.y *= stretch;
    } else if (canvasAspect < sceneAspect) {
      float stretch = sceneAspect / canvasAspect;
      normalized.x *= stretch;
    }

    gl_Position = vec4(normalized, 0.0, 1.0);
    v_texCoord = a_texCoord;
  }
`;

const fragmentSource = `
  precision mediump float;

  varying vec2 v_texCoord;
  uniform sampler2D u_texture;
  uniform float u_edgeFeather;

  void main() {
    vec4 color = texture2D(u_texture, v_texCoord);
    float edgeDistance = min(
      min(v_texCoord.x, 1.0 - v_texCoord.x),
      min(v_texCoord.y, 1.0 - v_texCoord.y)
    );
    float feather = smoothstep(0.0, u_edgeFeather, edgeDistance);
    float alpha = color.a * feather;
    gl_FragColor = vec4(color.rgb, alpha);
  }
`;

const createShader = (
  gl: WebGLRenderingContext,
  type: number,
  source: string
) => {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Failed to create shader.");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(info ?? "Unknown shader compilation error.");
  }
  return shader;
};

const createProgram = (
  gl: WebGLRenderingContext,
  vertexShader: WebGLShader,
  fragmentShader: WebGLShader
) => {
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Failed to create WebGL program.");
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(info ?? "Unknown program link error.");
  }
  return program;
};

const buildLayers = (images: string[]): Layer[] =>
  images.map((src, index) => ({
    src,
    scale: BASE_SCALE * SCALE_FACTOR ** index,
  }));

const normalizeDepth = (value: number) => Math.max(value, 0);

export default function ZoomCanvas({
  images,
  onReady,
  orientation,
  rawOrientation,
  onZoomChange,
  enabled = true,
  isMobile = false,
}: ZoomCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(false);
  const orientationRef = useRef<number | null>(null);
  const rawOrientationRef = useRef<number | null>(null);
  const zoomRangeRef = useRef<{ min: number; max: number }>({ min: -1, max: 1 });
  const layerCount = images.length;

  // Keep orientation refs in sync with props
  useEffect(() => {
    orientationRef.current = orientation ?? null;
  }, [orientation]);

  useEffect(() => {
    rawOrientationRef.current = rawOrientation ?? null;
  }, [rawOrientation]);

  useEffect(() => {
    if (layerCount === 0) {
      onReady?.();
      return;
    }

    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!(canvas && container)) {
      return;
    }

    readyRef.current = false;
    const gl = canvas.getContext("webgl", { antialias: true, alpha: true });
    if (!gl) {
      onReady?.();
      return;
    }

    const layers = buildLayers(images);

    const updateZoomRange = (canvasAspect: number) => {
      const outerScale = layers[layerCount - 1]?.scale ?? 1;
      const innerScale = layers[0]?.scale ?? 1;
      const sceneAspect = BASE_RECT_WIDTH / BASE_RECT_HEIGHT;
      const aspectStretch =
        canvasAspect > sceneAspect
          ? canvasAspect / sceneAspect
          : sceneAspect / canvasAspect; // always >= 1

      if (isMobile) {
        // Rotation-independent closed form:
        // Max zoom-in: image height matches viewport height => s/zoom = 1 => zoom = s
        const minZoomScaleMobile = innerScale;
        // Max zoom-out: inscribed circle of image covers circumscribed circle of viewport at any angle
        // require (s/zoom) >= sqrt(2) => zoom <= s / sqrt(2)
        const maxZoomScaleMobile = outerScale / Math.SQRT2;

        const minExp = Math.log2(minZoomScaleMobile);
        const maxExp = Math.log2(maxZoomScaleMobile);
        zoomRangeRef.current =
          minExp <= maxExp ? { min: minExp, max: maxExp } : { min: maxExp, max: minExp };
        return;
      }

      // Desktop: fit inner (no crop) and cover outer (no background) without rotation dependence
      // Fit: s/zoom <= 1/aspectStretch => zoom >= s * aspectStretch^-1
      const fitStretch =
        canvasAspect >= sceneAspect ? aspectStretch : aspectStretch; // same expression, >=1
      const minZoomScaleDesktop = innerScale * fitStretch;

      // Cover: s/zoom >= 1 => zoom <= s
      const maxZoomScaleDesktop = outerScale;

      const minExp = Math.log2(minZoomScaleDesktop);
      const maxExp = Math.log2(maxZoomScaleDesktop);
      zoomRangeRef.current =
        minExp <= maxExp ? { min: minExp, max: maxExp } : { min: maxExp, max: minExp };
    };

    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = createProgram(gl, vertexShader, fragmentShader);

    const positionLocation = gl.getAttribLocation(program, "a_position");
    const texCoordLocation = gl.getAttribLocation(program, "a_texCoord");
    const scaleLocation = gl.getUniformLocation(program, "u_scale");
    const zoomLocation = gl.getUniformLocation(program, "u_zoom");
    const rotationLocation = gl.getUniformLocation(program, "u_rotation");
    const canvasSizeLocation = gl.getUniformLocation(program, "u_canvasSize");
    const baseSizeLocation = gl.getUniformLocation(program, "u_baseSize");
    const textureLocation = gl.getUniformLocation(program, "u_texture");
    const edgeFeatherLocation = gl.getUniformLocation(program, "u_edgeFeather");

    if (
      positionLocation === -1 ||
      texCoordLocation === -1 ||
      scaleLocation === null ||
      zoomLocation === null ||
      rotationLocation === null ||
      canvasSizeLocation === null ||
      baseSizeLocation === null ||
      textureLocation === null ||
      edgeFeatherLocation === null
    ) {
      return;
    }

    const halfWidth = BASE_RECT_WIDTH / 2;
    const halfHeight = BASE_RECT_HEIGHT / 2;
    const baseVertices = new Float32Array([
      -halfWidth,
      -halfHeight,
      0,
      1,
      halfWidth,
      -halfHeight,
      1,
      1,
      -halfWidth,
      halfHeight,
      0,
      0,
      halfWidth,
      halfHeight,
      1,
      0,
    ]);

    const buffer = gl.createBuffer();
    if (!buffer) {
      return;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, baseVertices, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(
      positionLocation,
      POSITION_COMPONENTS,
      gl.FLOAT,
      false,
      VERTEX_STRIDE,
      POSITION_OFFSET
    );

    gl.enableVertexAttribArray(texCoordLocation);
    gl.vertexAttribPointer(
      texCoordLocation,
      TEXCOORD_COMPONENTS,
      gl.FLOAT,
      false,
      VERTEX_STRIDE,
      TEXCOORD_OFFSET
    );

    Reflect.apply(gl.useProgram, gl, [program]);
    gl.uniform2f(baseSizeLocation, BASE_RECT_WIDTH, BASE_RECT_HEIGHT);
    gl.uniform1i(textureLocation, TEXTURE_UNIT_INDEX);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const textures: (WebGLTexture | null)[] = new Array(layerCount).fill(null);
    let texturesReady = false;

    let animationFrame = 0;
    let cancelled = false;
    let targetZoomExponent = 0;
    let currentZoomExponent = 0;
    let pinchStartDistance = 0;
    let pinchStartExponent = 0;
    let pinchActive = false;
    let zoomInitialized = false;

    const getTouchDistance = (touches: TouchList) => {
      const [first, second] = [touches.item(0), touches.item(1)];
      if (!(first && second)) {
        return 0;
      }
      const dx = second.clientX - first.clientX;
      const dy = second.clientY - first.clientY;
      return Math.hypot(dx, dy);
    };

    const loadTexture = (source: string) =>
      new Promise<WebGLTexture>((resolve, reject) => {
        const image = new Image();
        image.decoding = "async";
        image.onload = () => {
          const texture = gl.createTexture();
          if (!texture) {
            reject(new Error("Failed to create texture."));
            return;
          }
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, FLIP_TEXTURE_COORDINATES);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            image
          );
          resolve(texture);
        };
        image.onerror = () => {
          reject(new Error(`Failed to load image: ${source}`));
        };
        image.src = source;
      });

    const disposeSettledTextures = (
      results: PromiseSettledResult<WebGLTexture>[]
    ) => {
      for (const result of results) {
        if (result.status === "fulfilled") {
          gl.deleteTexture(result.value);
        }
      }
    };

    const assignTexturesFromResults = (
      results: PromiseSettledResult<WebGLTexture>[]
    ) => {
      let hasTexture = false;
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status === "fulfilled") {
          textures[index] = result.value;
          hasTexture = true;
        }
      }
      texturesReady = hasTexture;
      if (!cancelled && texturesReady && !readyRef.current) {
        readyRef.current = true;
        onReady?.();
      }
    };

    const loadAllTextures = async () => {
      const results = await Promise.allSettled(
        layers.map((layer) => loadTexture(layer.src))
      );
      if (cancelled) {
        disposeSettledTextures(results);
        return;
      }

      assignTexturesFromResults(results);
      if (!cancelled && texturesReady && !readyRef.current) {
        readyRef.current = true;
        onReady?.();
      }
    };

    let wheelMomentum = 0;

    const handleWheel = (event: WheelEvent) => {
      if (!enabled) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const normalizedDelta = (() => {
        if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
          return event.deltaY;
        }
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
          return event.deltaY * LINE_TO_PIXEL_FACTOR;
        }
        if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
          return event.deltaY * PAGE_TO_PIXEL_FACTOR;
        }
        return event.deltaY;
      })();
      const clampedDelta = Math.max(
        -MAX_WHEEL_DELTA,
        Math.min(MAX_WHEEL_DELTA, normalizedDelta)
      );
      const scaledDelta = clampedDelta / WHEEL_NORMALIZATION_FACTOR;
      wheelMomentum += scaledDelta;
    };

    const beginPinch = (event: TouchEvent) => {
      if (!enabled || event.touches.length !== 2) {
        return;
      }
      pinchActive = true;
      pinchStartDistance = getTouchDistance(event.touches);
      pinchStartExponent = targetZoomExponent;
    };

    const updatePinch = (event: TouchEvent) => {
      if (!pinchActive || event.touches.length !== 2) {
        return;
      }
      const distance = getTouchDistance(event.touches);
      if (pinchStartDistance <= 0 || !Number.isFinite(distance)) {
        return;
      }
      const ratio = distance / pinchStartDistance;
      if (!Number.isFinite(ratio) || ratio <= 0) {
        return;
      }
      const deltaExponent = Math.log(ratio) / Math.log(SCALE_FACTOR);
      targetZoomExponent = pinchStartExponent - deltaExponent;

      // Clamp to valid range
      targetZoomExponent = Math.max(
        zoomRangeRef.current.min,
        Math.min(zoomRangeRef.current.max, targetZoomExponent)
      );
    };

    const endPinch = (event: TouchEvent) => {
      if (event.touches.length < 2) {
        pinchActive = false;
        pinchStartDistance = 0;
      }
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (!enabled) {
        if (event.touches.length === 2) {
          event.preventDefault();
        }
        return;
      }
      if (event.touches.length === 2) {
        event.preventDefault();
      }
      beginPinch(event);
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!enabled) {
        if (event.touches.length === 2) {
          event.preventDefault();
        }
        return;
      }
      if (event.touches.length === 2) {
        event.preventDefault();
      }
      updatePinch(event);
    };

    const handleTouchEnd = (event: TouchEvent) => {
      endPinch(event);
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || DEFAULT_DPR;
      const width = container.clientWidth;
      const height = container.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      gl.viewport(0, 0, canvas.width, canvas.height);

      const canvasAspect = width / height;
      updateZoomRange(canvasAspect);

      if (!zoomInitialized) {
        const midZoom =
          (zoomRangeRef.current.min + zoomRangeRef.current.max) / 2;
        targetZoomExponent = midZoom;
        currentZoomExponent = midZoom;
        pinchStartExponent = midZoom;
        zoomInitialized = true;
      } else {
        targetZoomExponent = Math.max(
          zoomRangeRef.current.min,
          Math.min(zoomRangeRef.current.max, targetZoomExponent)
        );
        currentZoomExponent = Math.max(
          zoomRangeRef.current.min,
          Math.min(zoomRangeRef.current.max, currentZoomExponent)
        );
        pinchStartExponent = Math.max(
          zoomRangeRef.current.min,
          Math.min(zoomRangeRef.current.max, pinchStartExponent)
        );
      }
    };

    const applyWheelMomentum = () => {
      if (wheelMomentum === 0) {
        return;
      }
      const deltaExponent = wheelMomentum * WHEEL_SENSITIVITY;
      targetZoomExponent += deltaExponent;

      // Clamp to valid range
      targetZoomExponent = Math.max(
        zoomRangeRef.current.min,
        Math.min(zoomRangeRef.current.max, targetZoomExponent)
      );

      wheelMomentum *= WHEEL_DAMPING;
      if (Math.abs(wheelMomentum) < WHEEL_EPSILON) {
        wheelMomentum = 0;
      }
    };

    const applyOrientationZoom = () => {
      const currentOrientation = orientationRef.current;
      if (currentOrientation === null) {
        return;
      }

      // Calculate zoom direction and magnitude
      // Positive orientation (tilt right) = zoom in (increase exponent)
      // Negative orientation (tilt left) = zoom out (decrease exponent)
      let zoomDelta = currentOrientation * ORIENTATION_ZOOM_SPEED;

      // Apply minimum speed - always moving at least a little in the tilt direction
      if (currentOrientation > ORIENTATION_DEAD_ZONE) {
        zoomDelta = Math.max(zoomDelta, MIN_ZOOM_SPEED);
      } else if (currentOrientation < -ORIENTATION_DEAD_ZONE) {
        zoomDelta = Math.min(zoomDelta, -MIN_ZOOM_SPEED);
      }

      targetZoomExponent += zoomDelta * FRAME_TIME_FACTOR;

      // Clamp to valid range
      targetZoomExponent = Math.max(
        zoomRangeRef.current.min,
        Math.min(zoomRangeRef.current.max, targetZoomExponent)
      );
    };

    const stepZoom = () => {
      currentZoomExponent +=
        (targetZoomExponent - currentZoomExponent) * ZOOM_EASING;
      if (Math.abs(targetZoomExponent - currentZoomExponent) < ZOOM_TOLERANCE) {
        currentZoomExponent = targetZoomExponent;
      }
      return SCALE_FACTOR ** currentZoomExponent;
    };

    const drawScene = (zoomScale: number) => {
      gl.clearColor(CLEAR_COLOR.r, CLEAR_COLOR.g, CLEAR_COLOR.b, CLEAR_COLOR.a);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.uniform1f(zoomLocation, zoomScale);
      gl.uniform2f(canvasSizeLocation, canvas.width, canvas.height);

      // Rotate images based on device orientation (use raw value for accurate rotation)
      const currentRawOrientation = rawOrientationRef.current ?? 0;
      const rotationRadians = currentRawOrientation * DEG_TO_RAD;
      gl.uniform1f(rotationLocation, rotationRadians);

      gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT_INDEX);

      for (let index = layers.length - 1; index >= 0; index -= 1) {
        const texture = textures[index];
        if (!texture) {
          continue;
        }
        gl.bindTexture(gl.TEXTURE_2D, texture);
        const feather =
          index === layers.length - 1 ? OUTER_EDGE_FEATHER : EDGE_FEATHER_WIDTH;
        gl.uniform1f(edgeFeatherLocation, feather);
        gl.uniform1f(scaleLocation, layers[index]?.scale ?? BASE_SCALE);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, RECTANGLE_VERTEX_COUNT);
      }
    };

    const render = () => {
      if (cancelled) {
        return;
      }

      if (!texturesReady) {
        animationFrame = requestAnimationFrame(render);
        return;
      }

      applyWheelMomentum();
      applyOrientationZoom();

      // Fast snap-back when not interacting
      if (!pinchActive && wheelMomentum === 0) {
        if (targetZoomExponent < zoomRangeRef.current.min) {
          targetZoomExponent +=
            (zoomRangeRef.current.min - targetZoomExponent) * SNAP_BACK_SPEED;
          if (
            Math.abs(targetZoomExponent - zoomRangeRef.current.min) < ZOOM_TOLERANCE
          ) {
            targetZoomExponent = zoomRangeRef.current.min;
          }
        } else if (targetZoomExponent > zoomRangeRef.current.max) {
          targetZoomExponent +=
            (zoomRangeRef.current.max - targetZoomExponent) * SNAP_BACK_SPEED;
          if (
            Math.abs(targetZoomExponent - zoomRangeRef.current.max) < ZOOM_TOLERANCE
          ) {
            targetZoomExponent = zoomRangeRef.current.max;
          }
        }
      }

      const zoomScale = stepZoom();
      drawScene(zoomScale);

      // Report zoom change to parent
      if (onZoomChange) {
        onZoomChange(currentZoomExponent, zoomRangeRef.current);
      }

      animationFrame = requestAnimationFrame(render);
    };

    resize();
    container.addEventListener("wheel", handleWheel, { passive: false });
    container.addEventListener("touchstart", handleTouchStart, {
      passive: false,
    });
    container.addEventListener("touchmove", handleTouchMove, {
      passive: false,
    });
    container.addEventListener("touchend", handleTouchEnd);
    container.addEventListener("touchcancel", handleTouchEnd);
    window.addEventListener("resize", resize);
    animationFrame = requestAnimationFrame(render);

    loadAllTextures();

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchEnd);
      window.removeEventListener("resize", resize);
      for (const texture of textures) {
        if (texture) {
          gl.deleteTexture(texture);
        }
      }
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    };
    }, [images, layerCount, onReady, enabled, isMobile]);

  if (layerCount === 0) {
    return null;
  }

  return (
    <div className="absolute inset-0 touch-none" ref={containerRef}>
      <canvas
        aria-label="WebGL long zoom simulation"
        className="block h-full w-full"
        ref={canvasRef}
      />
    </div>
  );
}
