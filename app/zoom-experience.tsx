"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const BUTTON_RADIUS = 24; // Radius of each circular button
const INNER_RADIUS = 50; // Inner radius of the ring
// Derived values:
// - Buttons arranged along circle at: INNER_RADIUS + BUTTON_RADIUS
// - Outer radius of ring: INNER_RADIUS + 2 * BUTTON_RADIUS
const BUTTON_CIRCLE_RADIUS = INNER_RADIUS + BUTTON_RADIUS;
const OUTER_RADIUS = INNER_RADIUS + 2 * BUTTON_RADIUS;
const RING_THICKNESS = 2 * BUTTON_RADIUS; // Outer - Inner
const ROTATION_EASING = 0.12;
const SNAP_THRESHOLD = 0.1;

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
  const [isMobile, setIsMobile] = useState(false);

  // Circular selector state
  const [mounted, setMounted] = useState(false);
  
  useEffect(() => {
    setMounted(true);
  }, []);

  const initialIndex = useMemo(() => {
    const idx = imageSets.findIndex((set) => set.name === resolveInitialSet());
    return idx >= 0 ? idx : 0;
  }, [imageSets, resolveInitialSet]);
  
  const [ringRotation, setRingRotation] = useState(0);
  const [targetRotation, setTargetRotation] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const dragStartRef = useRef<{ lastAngle: number } | null>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);

  const anglePerItem = useMemo(
    () => (imageSets.length > 0 ? (2 * Math.PI) / imageSets.length : 0),
    [imageSets.length]
  );

  // Get the index of the item at the bottom (selected)
  const selectedIndex = useMemo(() => {
    if (imageSets.length === 0) return 0;
    // Normalize rotation to 0-2π range
    const normalizedRotation = ((ringRotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    // When ringRotation = 0, item at index 0 is at bottom (PI/2)
    // The ring rotates counter-clockwise (negative rotation applied)
    // So as ringRotation increases, we need to find which index is now at bottom
    const rawIndex = Math.round(normalizedRotation / anglePerItem);
    return ((rawIndex % imageSets.length) + imageSets.length) % imageSets.length;
  }, [ringRotation, anglePerItem, imageSets.length]);

  // Animation loop for smooth rotation
  useEffect(() => {
    const animate = () => {
      setRingRotation((prev) => {
        const diff = targetRotation - prev;
        if (Math.abs(diff) < 0.001) return targetRotation;
        return prev + diff * ROTATION_EASING;
      });
      animationRef.current = requestAnimationFrame(animate);
    };
    animationRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationRef.current);
  }, [targetRotation]);

  // Snap to nearest item when not dragging
  useEffect(() => {
    if (!isDragging && imageSets.length > 0) {
      const nearestIndex = Math.round(targetRotation / anglePerItem);
      const snappedRotation = nearestIndex * anglePerItem;
      if (Math.abs(targetRotation - snappedRotation) > SNAP_THRESHOLD * anglePerItem) {
        setTargetRotation(snappedRotation);
      }
    }
  }, [isDragging, targetRotation, anglePerItem, imageSets.length]);

  // Calculate angle from center of ring to pointer
  const getPointerAngle = useCallback((clientX: number, clientY: number) => {
    if (!ringRef.current) return 0;
    const rect = ringRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    return Math.atan2(clientY - centerY, clientX - centerX);
  }, []);

  // Handle hover
  const handlePointerEnter = useCallback(() => {
    setIsHovered(true);
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (!isDragging) {
      setIsHovered(false);
    }
  }, [isDragging]);

  // Handle drag start
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (fadePhase !== "idle") return;
    setIsDragging(true);
    setIsHovered(true);
    const lastAngle = getPointerAngle(e.clientX, e.clientY);
    dragStartRef.current = { lastAngle };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [fadePhase, getPointerAngle]);

  // Handle drag move
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging || !dragStartRef.current) return;
    
    const currentAngle = getPointerAngle(e.clientX, e.clientY);
    let delta = currentAngle - dragStartRef.current.lastAngle;
    
    // Handle wrap-around for the small movement
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;

    dragStartRef.current.lastAngle = currentAngle;

    // Apply rotation (subtract delta to follow finger)
    setTargetRotation((prev) => prev - delta);
  }, [isDragging, getPointerAngle]);

  // Handle drag end and snap to nearest
  const handlePointerUp = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);
    dragStartRef.current = null;
    
    // Snap to nearest item
    const nearestIndex = Math.round(targetRotation / anglePerItem);
    setTargetRotation(nearestIndex * anglePerItem);
  }, [isDragging, targetRotation, anglePerItem]);

  // Reset hover state when drag ends
  useEffect(() => {
    if (!isDragging) {
      setIsHovered(false);
    }
  }, [isDragging]);

  // Handle wheel for rotation
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (fadePhase !== "idle") return;
    e.preventDefault();
    const delta = e.deltaY * 0.003;
    setTargetRotation((prev) => prev + delta);
  }, [fadePhase]);


  // Initialize ring rotation based on initial set
  useEffect(() => {
    setRingRotation(initialIndex * anglePerItem);
    setTargetRotation(initialIndex * anglePerItem);
  }, [initialIndex, anglePerItem]);

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
    // Detect if mobile device
    const checkMobile = () => {
      const userAgent = navigator.userAgent || navigator.vendor;
      const isMobileDevice = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent.toLowerCase());
      setIsMobile(isMobileDevice);
      return isMobileDevice;
    };
    
    const mobile = checkMobile();
    
    // biome-ignore lint/suspicious/noExplicitAny: iOS-specific API
    const DeviceMotionEventClass = DeviceMotionEvent as any;
    
    // Check if permission API exists (iOS 13+)
    const hasPermissionAPI = typeof DeviceMotionEventClass.requestPermission === "function";
    
    if (hasPermissionAPI && mobile) {
      setPermissionState("needs-permission");
    } else {
      // Non-iOS or older iOS or desktop - permission not needed, events fire automatically
      setPermissionState("granted");
    }

    // Low-pass filter for smoothing (0.05 = very smooth, 0.5 = more responsive)
    const smoothingFactor = 0.06;
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

  // Trigger transition when selected item changes
  useEffect(() => {
    const selectedSet = imageSets[selectedIndex];
    if (selectedSet && selectedSet.name !== highlightSet && !isDragging) {
      startTransition(selectedSet.name);
    }
  }, [selectedIndex, imageSets, highlightSet, isDragging, startTransition]);

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
      
      {/* Permission prompt - only on mobile, centered */}
      {isMobile && permissionState === "needs-permission" && (
        <div className="absolute inset-0 flex items-center justify-center z-50">
          <button
            className="flex h-32 w-32 flex-col items-center justify-center rounded-full bg-white/10 backdrop-blur-md text-xs font-medium text-white hover:bg-white/20 active:scale-95 transition-all cursor-pointer shadow-2xl"
            onClick={requestMotionPermission}
            type="button"
          >
            Tap to enable<br />gyroscope
          </button>
        </div>
      )}

      <div className={overlayClass} />
      
      {/* Circular ring selector */}
      {mounted && (
        <div
          className="absolute flex items-center justify-center"
          style={{
            left: "50%",
            bottom: "2rem",
            transform: "translateX(-50%)",
            width: OUTER_RADIUS * 2,
            height: OUTER_RADIUS * 2,
          }}
        >
          {/* Ring container - rotates as a whole (hidden when not interacting) */}
          <div
            ref={ringRef}
            className="absolute inset-0 touch-none transition-opacity duration-300"
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onWheel={handleWheel}
            style={{ 
              touchAction: "none",
              transform: `rotate(${-ringRotation}rad)`,
              pointerEvents: isHovered || isDragging ? "auto" : "none",
            }}
          >
            {/* Ring background - only the ring band, not the center */}
            <div
              className="absolute rounded-full pointer-events-none transition-opacity duration-300"
              style={{
                width: OUTER_RADIUS * 2,
                height: OUTER_RADIUS * 2,
                left: "50%",
                top: "50%",
                transform: "translate(-50%, -50%)",
                background: `radial-gradient(circle, transparent ${INNER_RADIUS}px, rgba(0, 0, 0, 0.5) ${INNER_RADIUS}px, rgba(0, 0, 0, 0.5) ${OUTER_RADIUS}px, transparent ${OUTER_RADIUS}px)`,
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                opacity: isHovered || isDragging ? 1 : 0,
              }}
            />
            
            {/* Image items positioned on the ring */}
            {imageSets.map((set, index) => {
              // Position each item around the circle at BUTTON_CIRCLE_RADIUS
              // Start at bottom (0 degrees = π/2), going clockwise
              const itemAngle = index * anglePerItem + Math.PI / 2;
              const x = Math.cos(itemAngle) * BUTTON_CIRCLE_RADIUS;
              const y = Math.sin(itemAngle) * BUTTON_CIRCLE_RADIUS;
              
              // Check if this item is at the bottom (selected position)
              // Bottom is at angle PI/2 after rotation
              const isAtBottom = index === selectedIndex;
              const preview = set.images[0];
              const label = formatLabel(set.name);
              
              // Show all items when hovered/dragging, only selected when not
              const shouldShow = isHovered || isDragging || isAtBottom;
              
              return (
                <div
                  key={set.name}
                  className="absolute transition-opacity duration-300"
                  style={{
                    width: `${BUTTON_RADIUS * 2}px`,
                    height: `${BUTTON_RADIUS * 2}px`,
                    left: "50%",
                    top: "50%",
                    transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) rotate(${itemAngle - Math.PI / 2}rad)`,
                    zIndex: isAtBottom ? 10 : 1,
                    opacity: shouldShow ? 1 : 0,
                    pointerEvents: isAtBottom ? "auto" : "none",
                    cursor: isAtBottom ? "grab" : "default",
                  }}
                  onPointerDown={isAtBottom ? handlePointerDown : undefined}
                  onPointerEnter={isAtBottom ? handlePointerEnter : undefined}
                  onPointerLeave={isAtBottom ? handlePointerLeave : undefined}
                >
                  <div
                    className={cx(
                      "relative h-full w-full overflow-hidden rounded-full border-2 bg-black/50",
                      isAtBottom
                        ? "border-white shadow-[0_0_20px_rgba(255,255,255,0.3)]"
                        : "border-transparent",
                      isDragging && isAtBottom ? "cursor-grabbing" : ""
                    )}
                  >
                    {preview ? (
                      <Image
                        alt={label}
                        className="h-full w-full object-cover select-none"
                        fill
                        priority={isAtBottom}
                        sizes={`${BUTTON_RADIUS * 2}px`}
                        src={preview}
                        draggable={false}
                        style={{ pointerEvents: "none" }}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
