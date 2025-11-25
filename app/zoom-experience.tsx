"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import ZoomCanvas from "./zoom-canvas";

type ZoomExperienceProps = {
  imageSets: ImageSet[];
  initialSet?: string;
};

export type ImageSet = {
  name: string;
  images: string[];
};

const FADE_DURATION_MS = 450;
const BLACK_HOLD_MS = 120;

declare global {
  interface DeviceOrientationEvent {
    requestPermission?: () => Promise<"granted" | "denied">;
  }
}

const formatLabel = (name: string) =>
  name.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

const cx = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

export default function ZoomExperience({
  imageSets,
  initialSet,
}: ZoomExperienceProps) {
  const resolveInitialSet = useCallback(() => {
    if (initialSet) {
      const match = imageSets.find((set) => set.name === initialSet);
      if (match) {
        return match.name;
      }
    }
    return imageSets[0]?.name ?? "";
  }, [imageSets, initialSet]);

  const [activeSet, setActiveSet] = useState(resolveInitialSet);
  const [pendingSet, setPendingSet] = useState<string | null>(null);
  const [fadePhase, setFadePhase] = useState<
    "idle" | "fading-in" | "waiting" | "fading-out"
  >("idle");
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [highlightSet, setHighlightSet] = useState(() => resolveInitialSet());
  const [fadeInComplete, setFadeInComplete] = useState(false);
  const [revealReady, setRevealReady] = useState(false);
  const [orientation, setOrientation] = useState<number | null>(null);
  const [rawOrientation, setRawOrientation] = useState<number | null>(null);
  const [permissionState, setPermissionState] = useState<
    "checking" | "needs-permission" | "granted" | "denied" | "unavailable"
  >("checking");

  const requestMotionPermission = useCallback(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: iOS-specific API
    const DeviceMotionEventClass = DeviceMotionEvent as any;
    
    if (typeof DeviceMotionEventClass.requestPermission === "function") {
      try {
        const permission = await DeviceMotionEventClass.requestPermission();
        if (permission === "granted") {
          setPermissionState("granted");
        } else {
          setPermissionState("denied");
        }
      } catch (error) {
        console.error("Permission request failed:", error);
        setPermissionState("denied");
      }
    }
  }, []);

  useEffect(() => {
    // biome-ignore lint/suspicious/noExplicitAny: iOS-specific API
    const DeviceMotionEventClass = DeviceMotionEvent as any;
    
    // Check if permission API exists (iOS 13+)
    const hasPermissionAPI = typeof DeviceMotionEventClass.requestPermission === "function";
    
    if (hasPermissionAPI) {
      setPermissionState("needs-permission");
    } else {
      // Non-iOS or older iOS - permission not needed, events fire automatically
      setPermissionState("granted");
    }

    // Low-pass filter for smoothing (0.1 = very smooth, 0.5 = more responsive)
    const smoothingFactor = 0.15;
    let smoothedDegrees: number | null = null;

    const handleMotion = (event: DeviceMotionEvent) => {
      // Use accelerometer to get tilt relative to gravity
      // This is independent of compass heading (alpha)
      const accel = event.accelerationIncludingGravity;
      if (accel && accel.x !== null && accel.y !== null) {
        // When phone is upright (charging port down, screen facing you):
        // - gravity points down (negative y in device coords)
        // - x tells us left-right tilt
        // atan2(x, -y) gives angle in radians, convert to degrees
        const radians = Math.atan2(accel.x, -accel.y);
        const degrees = radians * (180 / Math.PI);
        
        // Apply low-pass filter for smoothing
        if (smoothedDegrees === null) {
          smoothedDegrees = degrees;
        } else {
          smoothedDegrees = smoothedDegrees * (1 - smoothingFactor) + degrees * smoothingFactor;
        }
        
        // Raw value for rotation (smoothed), clamped to ±90° (landscape limits)
        const rotationClamped = Math.max(-90, Math.min(90, smoothedDegrees));
        setRawOrientation(rotationClamped);
        // Clamped value for zoom control and display
        const clamped = Math.max(-60, Math.min(60, smoothedDegrees));
        setOrientation(Math.round(clamped));
        if (hasPermissionAPI) {
          setPermissionState("granted");
        }
      }
    };

    window.addEventListener("devicemotion", handleMotion);
    return () => window.removeEventListener("devicemotion", handleMotion);
  }, []);

  useEffect(() => {
    if (imageSets.length === 0) {
      return;
    }
    const exists = imageSets.some((set) => set.name === activeSet);
    if (!exists) {
      setActiveSet(resolveInitialSet());
      setPendingSet(null);
      setFadePhase("idle");
      setOverlayVisible(false);
    }
  }, [activeSet, imageSets, resolveInitialSet]);

  const activeImages = useMemo(() => {
    if (imageSets.length === 0) {
      return [] as string[];
    }
    const selected = imageSets.find((set) => set.name === activeSet);
    return selected?.images ?? imageSets[0]?.images ?? [];
  }, [activeSet, imageSets]);

  const overlayClass = cx(
    "pointer-events-none absolute inset-0 bg-black transition-opacity duration-[450ms] ease-linear",
    overlayVisible ? "opacity-100" : "opacity-0"
  );

  const startTransition = useCallback(
    (target: string) => {
      if (fadePhase !== "idle" || target === activeSet) {
        return;
      }
      setPendingSet(target);
      setHighlightSet(target);
      setFadeInComplete(false);
      setRevealReady(false);
      setOverlayVisible(true);
      setFadePhase("fading-in");
    },
    [activeSet, fadePhase]
  );

  useEffect(() => {
    if (fadePhase === "fading-in") {
      const timer = window.setTimeout(() => {
        if (pendingSet) {
          setActiveSet(pendingSet);
          setPendingSet(null);
        }
        setFadeInComplete(true);
        setFadePhase("waiting");
      }, FADE_DURATION_MS);
      return () => window.clearTimeout(timer);
    }

    if (fadePhase === "fading-out") {
      setOverlayVisible(false);
      const timer = window.setTimeout(() => {
        setOverlayVisible(false);
        setFadePhase("idle");
        setFadeInComplete(false);
        setRevealReady(false);
      }, FADE_DURATION_MS);
      return () => window.clearTimeout(timer);
    }
    return;
  }, [fadePhase, pendingSet]);

  const handleCanvasReady = useCallback(() => {
    setRevealReady(true);
  }, []);

  useEffect(() => {
    if (fadePhase === "waiting" && fadeInComplete && revealReady) {
      window.setTimeout(() => {
        setOverlayVisible(false);
        setFadePhase("fading-out");
      }, BLACK_HOLD_MS);
    }
  }, [fadePhase, fadeInComplete, revealReady]);

  useEffect(() => {
    setHighlightSet(activeSet);
  }, [activeSet]);

  if (imageSets.length === 0) {
    return (
      <div
        className="relative min-h-[100dvh] min-h-[100svh] w-screen overflow-hidden bg-black text-white"
        style={{ minHeight: "100dvh" }}
      >
        <div className="absolute inset-0 flex items-center justify-center bg-black">
          <p className="text-sm opacity-70">
            Add image collections to <code>public/images</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative min-h-[100dvh] min-h-[100svh] w-screen overflow-hidden bg-black"
      style={{ minHeight: "100dvh" }}
    >
      <ZoomCanvas images={activeImages} onReady={handleCanvasReady} orientation={orientation} rawOrientation={rawOrientation} />
      
      {/* Orientation circle */}
      <div className="absolute top-4 right-4 z-10" style={{ pointerEvents: "none" }}>
        {permissionState === "needs-permission" ? (
          <button
            className="flex h-16 w-16 flex-col items-center justify-center rounded-full border-2 border-white/80 bg-white/10 backdrop-blur-sm text-[10px] font-medium text-white/90 hover:text-white hover:bg-white/20 active:scale-95 transition-all cursor-pointer"
            onClick={requestMotionPermission}
            style={{ pointerEvents: "auto" }}
            type="button"
          >
            Tap to<br />Enable
          </button>
        ) : (
          <div className="flex h-16 w-16 flex-col items-center justify-center rounded-full border-2 border-white/80 bg-white/10 backdrop-blur-sm">
            {permissionState === "denied" ? (
              <span className="text-[10px] text-white/60 text-center px-1">Denied</span>
            ) : permissionState === "checking" ? (
              <span className="text-[10px] text-white/60">...</span>
            ) : rawOrientation !== null ? (
              <span className="font-mono text-xl font-bold tabular-nums text-white">
                {rawOrientation > 0 ? "+" : ""}{Math.round(rawOrientation)}°
              </span>
            ) : (
              <span className="text-[10px] text-white/60 text-center px-1">No sensor</span>
            )}
          </div>
        )}
      </div>

      <div className={overlayClass} />
      <div
        className="pointer-events-none absolute inset-x-0 flex justify-center"
        style={{
          bottom:
            "max(2.75rem, calc(env(safe-area-inset-bottom, 0px) + 2.75rem))",
        }}
      >
        <div className="flex gap-3 rounded-full bg-black/50 px-4 py-3 backdrop-blur-lg">
          {imageSets.map((set) => {
            const isActive = set.name === highlightSet;
            const preview = set.images[0];
            const label = formatLabel(set.name);
            const isTransitioning = fadePhase !== "idle";
            return (
              <button
                aria-label={`View ${label} zoom`}
                aria-pressed={isActive}
                className={cx(
                  "group pointer-events-auto relative h-12 w-12 overflow-hidden rounded-full border border-white/60 bg-transparent transition-opacity duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/80 focus-visible:outline-offset-3 disabled:cursor-wait",
                  isActive
                    ? "border-white opacity-100 shadow-[0_10px_25px_rgba(0,0,0,0.4)]"
                    : "opacity-70"
                )}
                disabled={isTransitioning}
                key={set.name}
                onClick={() => startTransition(set.name)}
                type="button"
              >
                {preview ? (
                  <Image
                    alt={label}
                    className={cx(
                      "h-full w-full object-cover transition duration-200 group-hover:grayscale-0",
                      isActive ? "grayscale-0" : "grayscale"
                    )}
                    fill
                    priority={isActive}
                    sizes="48px"
                    src={preview}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
