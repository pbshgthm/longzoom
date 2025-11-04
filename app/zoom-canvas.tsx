"use client";

import { useEffect, useRef } from "react";

type ZoomCanvasProps = {
  images: string[];
  onReady?: () => void;
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
const ZOOM_EASING = 0.1;
const ZOOM_TOLERANCE = 0.001;
const WHEEL_SENSITIVITY = 0.0015;
const INNER_FIT_EXPONENT = 0.75;
const LINE_TO_PIXEL_FACTOR = 16;
const PAGE_TO_PIXEL_FACTOR = 800;
const MAX_WHEEL_DELTA = 120;
const WHEEL_NORMALIZATION_FACTOR = 300;
const WHEEL_DAMPING = 0.75;
const WHEEL_EPSILON = 0.0001;
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

const vertexSource = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;

  uniform float u_scale;
  uniform float u_zoom;
  uniform vec2 u_canvasSize;
  uniform vec2 u_baseSize;

  varying vec2 v_texCoord;

  void main() {
    vec2 scaled = (a_position * u_scale) / u_zoom;
    vec2 normalized = vec2(
      scaled.x / (u_baseSize.x * 0.5),
      scaled.y / (u_baseSize.y * 0.5)
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

export default function ZoomCanvas({ images, onReady }: ZoomCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(false);
  const layerCount = images.length;

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
    const maxDepth = normalizeDepth(layers.length - 1);
    const innerFitExponent = Math.min(INNER_FIT_EXPONENT, maxDepth);
    const zoomExpRange = { min: innerFitExponent, max: maxDepth };
    const clampZoomExponent = (value: number) =>
      Math.min(zoomExpRange.max, Math.max(zoomExpRange.min, value));

    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = createProgram(gl, vertexShader, fragmentShader);

    const positionLocation = gl.getAttribLocation(program, "a_position");
    const texCoordLocation = gl.getAttribLocation(program, "a_texCoord");
    const scaleLocation = gl.getUniformLocation(program, "u_scale");
    const zoomLocation = gl.getUniformLocation(program, "u_zoom");
    const canvasSizeLocation = gl.getUniformLocation(program, "u_canvasSize");
    const baseSizeLocation = gl.getUniformLocation(program, "u_baseSize");
    const textureLocation = gl.getUniformLocation(program, "u_texture");
    const edgeFeatherLocation = gl.getUniformLocation(program, "u_edgeFeather");

    if (
      positionLocation === -1 ||
      texCoordLocation === -1 ||
      scaleLocation === null ||
      zoomLocation === null ||
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
    let targetZoomExponent = zoomExpRange.min;
    let currentZoomExponent = zoomExpRange.min;
    let pinchStartDistance = 0;
    let pinchStartExponent = zoomExpRange.min;
    let pinchActive = false;

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
      if (event.touches.length !== 2) {
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
      targetZoomExponent = clampZoomExponent(
        pinchStartExponent - deltaExponent
      );
    };

    const endPinch = (event: TouchEvent) => {
      if (event.touches.length < 2) {
        pinchActive = false;
        pinchStartDistance = 0;
      }
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        event.preventDefault();
      }
      beginPinch(event);
    };

    const handleTouchMove = (event: TouchEvent) => {
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
    };

    const applyWheelMomentum = () => {
      if (wheelMomentum === 0) {
        return;
      }
      const deltaExponent = wheelMomentum * WHEEL_SENSITIVITY;
      targetZoomExponent = clampZoomExponent(
        targetZoomExponent + deltaExponent
      );
      wheelMomentum *= WHEEL_DAMPING;
      if (Math.abs(wheelMomentum) < WHEEL_EPSILON) {
        wheelMomentum = 0;
      }
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
      const zoomScale = stepZoom();
      drawScene(zoomScale);

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
  }, [images, layerCount, onReady]);

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
