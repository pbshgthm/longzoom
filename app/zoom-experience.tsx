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

const FADE_IN_DURATION_MS = 400; // 0 -> 50% opacity
const FADE_TO_BLACK_DURATION_MS = 400; // 50% -> 100% opacity
const HOLD_DURATION_MS = 200; // Hold at 100% while swapping images
const FADE_OUT_DURATION_MS = 800; // 100% -> 0% opacity
const BUTTON_RADIUS = 30; // Radius of each circular button
const INNER_RADIUS = 65; // Inner radius of the ring
const PADDING = 16; // Padding between buttons and outer edge
// Derived values:
// - Buttons arranged along circle at: INNER_RADIUS + BUTTON_RADIUS
// - Outer radius of ring: INNER_RADIUS + 2 * BUTTON_RADIUS + PADDING
const BUTTON_CIRCLE_RADIUS = INNER_RADIUS + BUTTON_RADIUS;
const OUTER_RADIUS = INNER_RADIUS + 2 * BUTTON_RADIUS + PADDING;
const RING_THICKNESS = 2 * BUTTON_RADIUS + PADDING; // Outer - Inner
const ROTATION_EASING = 0.12;
const SNAP_THRESHOLD = 0.1;
const CLICKS_PER_FULL_CIRCLE = 24; // Number of tick sounds per full rotation
const MIN_PLAYBACK_RATE = 1 / 2; // 1/2x speed at max zoom out (0.5)
const MAX_PLAYBACK_RATE = 2.0; // 2x speed at max zoom in
const MIDDLE_PLAYBACK_RATE = 1.0; // 1x speed at middle zoom
// Quadratic coefficients for mapping normalized zoom (0-1) to playback rate
// Formula: QUADRATIC_A * normalized^2 + QUADRATIC_B * normalized + MIN_PLAYBACK_RATE
// Maps: 0 → 1/2 (0.5), 0.5 → 1.0, 1 → 2.0
// Calculated: a = 1.0, b = 0.5
const QUADRATIC_A = 1.0;
const QUADRATIC_B = 0.5;
const RING_HIDE_DELAY_MS = 2000; // keep ring/buttons visible briefly after start or tap

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
    // Default to "animals" if available, otherwise fall back to first set
    const animalsSet = imageSets.find((set) => set.name === "animals");
    return animalsSet?.name ?? imageSets[0]?.name ?? "";
  }, [imageSets, initialSet]);

  const [activeSet, setActiveSet] = useState(resolveInitialSet);
  const [pendingSet, setPendingSet] = useState<string | null>(null);
  const [fadePhase, setFadePhase] = useState<
    | "idle"
    | "fading-in"
    | "loading"
    | "fading-to-black"
    | "holding"
    | "fading-out"
  >("idle");
  // Overlay states: hidden (0%), half (50% + blur), full (100% black), fading (transitioning to 0%)
  const [overlayState, setOverlayState] = useState<
    "hidden" | "half" | "full" | "fading"
  >("hidden");
  const [highlightSet, setHighlightSet] = useState(() => resolveInitialSet());
  const [revealReady, setRevealReady] = useState(false);
  const [orientation, setOrientation] = useState<number | null>(null);
  const [rawOrientation, setRawOrientation] = useState<number | null>(null);
  const [permissionState, setPermissionState] = useState<
    "checking" | "needs-permission" | "granted" | "denied" | "unavailable"
  >("checking");
  const [isMobile, setIsMobile] = useState(false);
  const [audioStarted, setAudioStarted] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [dotCount, setDotCount] = useState(1);
  const [minLoadingTimePassed, setMinLoadingTimePassed] = useState(false);

  // Circular selector state
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Animate the loading dots (1, 2, 3, 1, 2, 3...)
  useEffect(() => {
    const isVisible = isInitialLoading || !minLoadingTimePassed;
    if (!isVisible) return;
    const interval = setInterval(() => {
      setDotCount((prev) => {
        if (prev >= 3) {
          return 1;
        }
        return prev + 1;
      });
    }, 250);
    return () => clearInterval(interval);
  }, [isInitialLoading, minLoadingTimePassed]);

  // Minimum loading time of 1 second
  useEffect(() => {
    const timer = setTimeout(() => {
      setMinLoadingTimePassed(true);
    }, 1000);
    return () => clearTimeout(timer);
  }, []);

  const initialIndex = useMemo(() => {
    const idx = imageSets.findIndex((set) => set.name === resolveInitialSet());
    return idx >= 0 ? idx : 0;
  }, [imageSets, resolveInitialSet]);

  const [ringRotation, setRingRotation] = useState(0);
  const [targetRotation, setTargetRotation] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [showRingAfterStart, setShowRingAfterStart] = useState(false);
  const [hideRing, setHideRing] = useState(false);
  const dragStartRef = useRef<{ lastAngle: number } | null>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  const hoverTimeoutRef = useRef<number | null>(null);
  const audioStartTimeoutRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const tickBufferRef = useRef<AudioBuffer | null>(null);
  const lastClickIndexRef = useRef<number | null>(null);
  const bgMusicRef = useRef<AudioBufferSourceNode | null>(null);
  const bgMusicGainRef = useRef<GainNode | null>(null);
  const bgMusicBufferRef = useRef<AudioBuffer | null>(null);
  const isMutedRef = useRef(false);
  const zoomRangeRef = useRef<{ min: number; max: number } | null>(null);

  const anglePerItem = useMemo(
    () => (imageSets.length > 0 ? (2 * Math.PI) / imageSets.length : 0),
    [imageSets.length]
  );

  const anglePerClick = useMemo(
    () => (2 * Math.PI) / CLICKS_PER_FULL_CIRCLE,
    []
  );

  const showRingTemporarily = useCallback(() => {
    setHideRing(false);
    setShowRingAfterStart(true);
    if (audioStartTimeoutRef.current !== null) {
      clearTimeout(audioStartTimeoutRef.current);
    }
    audioStartTimeoutRef.current = window.setTimeout(() => {
      setShowRingAfterStart(false);
      setHideRing(true);
      audioStartTimeoutRef.current = null;
    }, RING_HIDE_DELAY_MS);
  }, []);

  const hideRingAfterDelay = useCallback(() => {
    if (audioStartTimeoutRef.current !== null) {
      clearTimeout(audioStartTimeoutRef.current);
    }
    audioStartTimeoutRef.current = window.setTimeout(() => {
      setShowRingAfterStart(false);
      setHideRing(true);
      audioStartTimeoutRef.current = null;
    }, RING_HIDE_DELAY_MS);
  }, []);

  // Start audio - called by tapping the selector circle
  const startAudio = useCallback(async () => {
    if (audioStarted) return; // Already started

    try {
      // Request motion permission FIRST (must be in direct user gesture call stack on iOS)
      if (isMobile && permissionState === "needs-permission") {
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
            setPermissionState("denied");
          }
        }
      }

      // Initialize audio context if needed
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext();
        // Fetch and decode the tick sound
        const response = await fetch("/tick.mp3");
        const arrayBuffer = await response.arrayBuffer();
        tickBufferRef.current =
          await audioContextRef.current.decodeAudioData(arrayBuffer);
      } else if (audioContextRef.current.state === "suspended") {
        await audioContextRef.current.resume();
      }

      // Initialize background music using Web Audio API for smooth playbackRate changes
      if (!bgMusicBufferRef.current && audioContextRef.current) {
        try {
          // Load and decode the background music
          const response = await fetch("/bg.mp3");
          const arrayBuffer = await response.arrayBuffer();
          bgMusicBufferRef.current =
            await audioContextRef.current.decodeAudioData(arrayBuffer);
        } catch (error) {
          // Ignore errors
        }
      }

      // Start background music only if not muted and buffer is loaded
      if (
        !isMutedRef.current &&
        audioContextRef.current &&
        bgMusicBufferRef.current &&
        !bgMusicRef.current
      ) {
        const ctx = audioContextRef.current;

        // Create gain node for volume control
        const gain = ctx.createGain();
        gain.gain.value = 1.0;
        gain.connect(ctx.destination);
        bgMusicGainRef.current = gain;

        // Create buffer source
        const source = ctx.createBufferSource();
        source.buffer = bgMusicBufferRef.current;
        source.loop = true;
        source.playbackRate.value = MIDDLE_PLAYBACK_RATE;
        source.connect(gain);
        source.start(0);

        bgMusicRef.current = source;
      }

      setAudioStarted(true);
      showRingTemporarily();
    } catch {
      // Ignore errors
    }
  }, [audioStarted, isMobile, permissionState, showRingTemporarily]);

  // Sync mute ref with state
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  // Cleanup audio on unmount
  useEffect(
    () => () => {
      if (bgMusicRef.current) {
        bgMusicRef.current.stop();
        bgMusicRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    },
    []
  );

  // Play tick sound using Web Audio API (supports rapid playback on mobile)
  const playTick = useCallback(async () => {
    if (!(audioContextRef.current && tickBufferRef.current)) return;
    if (isMutedRef.current) return;

    try {
      // Resume context if suspended (mobile requirement)
      if (audioContextRef.current.state === "suspended") {
        await audioContextRef.current.resume();
      }

      // Ensure context is running
      if (audioContextRef.current.state !== "running") {
        return;
      }

      // Create a new buffer source for each play (Web Audio API pattern)
      const source = audioContextRef.current.createBufferSource();
      const gainNode = audioContextRef.current.createGain();
      gainNode.gain.value = 0.8; // Increased volume for better audibility

      source.buffer = tickBufferRef.current;
      source.connect(gainNode);
      gainNode.connect(audioContextRef.current.destination);
      source.start(0);
    } catch {
      // Ignore errors
    }
  }, []);

  // Update audio playback rate based on zoom
  // Using Web Audio API - smooth, real-time updates with zero stutter
  const updatePlaybackRate = useCallback(
    (zoomExponent: number, zoomRange: { min: number; max: number }) => {
      zoomRangeRef.current = zoomRange;

      if (!bgMusicRef.current || isMutedRef.current) return;

      // Normalize zoom exponent to 0-1 range
      const normalized =
        zoomRange.max === zoomRange.min
          ? 0.5
          : (zoomExponent - zoomRange.min) / (zoomRange.max - zoomRange.min);

      // Map normalized value (0-1) to playback rate using quadratic function
      // 0 → 0.25 (1/4x), 0.5 → 1.0 (1x), 1 → 4.0 (4x)
      // Formula: QUADRATIC_A * normalized^2 + QUADRATIC_B * normalized + MIN_PLAYBACK_RATE
      const playbackRate =
        QUADRATIC_A * normalized * normalized +
        QUADRATIC_B * normalized +
        MIN_PLAYBACK_RATE;

      // Update playbackRate directly - Web Audio API handles this smoothly
      bgMusicRef.current.playbackRate.value = playbackRate;
    },
    []
  );

  // Toggle mute state
  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const newMuted = !prev;
      // Update ref immediately for synchronous access
      isMutedRef.current = newMuted;

      // Update background music using gain node for mute/unmute
      if (bgMusicGainRef.current) {
        bgMusicGainRef.current.gain.value = newMuted ? 0 : 1.0;
      }

      // If unmuting and music isn't playing, start it
      if (
        !(newMuted || bgMusicRef.current) &&
        audioContextRef.current &&
        bgMusicBufferRef.current
      ) {
        const ctx = audioContextRef.current;
        const gain = ctx.createGain();
        gain.gain.value = 1.0;
        gain.connect(ctx.destination);
        bgMusicGainRef.current = gain;

        const source = ctx.createBufferSource();
        source.buffer = bgMusicBufferRef.current;
        source.loop = true;
        source.playbackRate.value = MIDDLE_PLAYBACK_RATE;
        source.connect(gain);
        source.start(0);

        bgMusicRef.current = source;
      }
      return newMuted;
    });
  }, []);

  // Check for tick sound when crossing click boundaries
  // Aligned so ticks occur when items reach the bottom position (PI/2)
  const checkAndPlayTick = useCallback(
    (rotation: number) => {
      // Offset rotation to align with bottom position (PI/2)
      // When rotation = 0, item at index 0 is at bottom (PI/2)
      // So we offset by -PI/2 to make bottom position = 0
      const offsetRotation = rotation - Math.PI / 2;
      const normalizedRotation =
        ((offsetRotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const currentClickIndex = Math.floor(normalizedRotation / anglePerClick);

      // Play sound if we've crossed a boundary
      if (lastClickIndexRef.current !== null) {
        const prevIndex = lastClickIndexRef.current;

        // Check if we've crossed a boundary (different click index)
        if (currentClickIndex !== prevIndex) {
          playTick();
        }
      }

      lastClickIndexRef.current = currentClickIndex;
    },
    [anglePerClick, playTick]
  );

  // Get the index of the item at the bottom (selected)
  const selectedIndex = useMemo(() => {
    if (imageSets.length === 0) return 0;
    // Normalize rotation to 0-2π range
    const normalizedRotation =
      ((ringRotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    // When ringRotation = 0, item at index 0 is at bottom (PI/2)
    // The ring rotates counter-clockwise (negative rotation applied)
    // So as ringRotation increases, we need to find which index is now at bottom
    const rawIndex = Math.round(normalizedRotation / anglePerItem);
    return (
      ((rawIndex % imageSets.length) + imageSets.length) % imageSets.length
    );
  }, [ringRotation, anglePerItem, imageSets.length]);

  // Animation loop for smooth rotation
  useEffect(() => {
    const animate = () => {
      setRingRotation((prev) => {
        const diff = targetRotation - prev;
        const newRotation =
          Math.abs(diff) < 0.001
            ? targetRotation
            : prev + diff * ROTATION_EASING;
        // Check for tick sound based on the actual animated rotation
        checkAndPlayTick(newRotation);
        return newRotation;
      });
      animationRef.current = requestAnimationFrame(animate);
    };
    animationRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationRef.current);
  }, [targetRotation, checkAndPlayTick]);

  // Snap to nearest item when not dragging
  useEffect(() => {
    if (!isDragging && imageSets.length > 0) {
      const nearestIndex = Math.round(targetRotation / anglePerItem);
      const snappedRotation = nearestIndex * anglePerItem;
      if (
        Math.abs(targetRotation - snappedRotation) >
        SNAP_THRESHOLD * anglePerItem
      ) {
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
    // Clear any pending fade out timeout
    if (hoverTimeoutRef.current !== null) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    // Cancel audio start fade-out if user hovers
    if (audioStartTimeoutRef.current !== null) {
      clearTimeout(audioStartTimeoutRef.current);
      audioStartTimeoutRef.current = null;
    }
    // Show everything when hovering
    setHideRing(false);
    setShowRingAfterStart(true);
    setIsHovered(true);
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (!isDragging) {
      // Clear any existing timeout
      if (hoverTimeoutRef.current !== null) {
        clearTimeout(hoverTimeoutRef.current);
      }
      // Set hover to false immediately
      setIsHovered(false);
      // Hide everything except selected button and selected circle bg after 2 seconds
      hideRingAfterDelay();
    }
  }, [isDragging, hideRingAfterDelay]);

  // Handle drag start
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!audioStarted || fadePhase !== "idle") return;
      setIsDragging(true);
      setIsHovered(true);
      const lastAngle = getPointerAngle(e.clientX, e.clientY);
      dragStartRef.current = { lastAngle };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [audioStarted, fadePhase, getPointerAngle]
  );

  // Handle drag move
  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!(isDragging && dragStartRef.current)) return;

      const currentAngle = getPointerAngle(e.clientX, e.clientY);
      let delta = currentAngle - dragStartRef.current.lastAngle;

      // Handle wrap-around for the small movement
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;

      dragStartRef.current.lastAngle = currentAngle;

      // Apply rotation (subtract delta to follow finger)
      setTargetRotation((prev) => prev - delta);
    },
    [isDragging, getPointerAngle]
  );

  // Handle drag end and snap to nearest
  const handlePointerUp = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);
    dragStartRef.current = null;

    // Snap to nearest item
    const nearestIndex = Math.round(targetRotation / anglePerItem);
    setTargetRotation(nearestIndex * anglePerItem);
    // Keep hover state active - let pointer leave handler manage fade out
  }, [isDragging, targetRotation, anglePerItem]);

  // Cleanup timeouts on unmount
  useEffect(
    () => () => {
      if (hoverTimeoutRef.current !== null) {
        clearTimeout(hoverTimeoutRef.current);
      }
      if (audioStartTimeoutRef.current !== null) {
        clearTimeout(audioStartTimeoutRef.current);
      }
    },
    []
  );

  // Handle wheel for rotation
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!audioStarted || fadePhase !== "idle") return;
      e.preventDefault();
      const delta = e.deltaY * 0.003;
      setTargetRotation((prev) => prev + delta);
    },
    [audioStarted, fadePhase]
  );

  // Initialize ring rotation based on initial set
  useEffect(() => {
    const initialRotation = initialIndex * anglePerItem;
    setRingRotation(initialRotation);
    setTargetRotation(initialRotation);
    // Initialize the last click index (with bottom position offset)
    const offsetRotation = initialRotation - Math.PI / 2;
    const normalizedRotation =
      ((offsetRotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    lastClickIndexRef.current = Math.floor(normalizedRotation / anglePerClick);
  }, [initialIndex, anglePerItem, anglePerClick]);

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
      const isMobileDevice =
        /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
          userAgent.toLowerCase()
        );
      setIsMobile(isMobileDevice);
      return isMobileDevice;
    };

    const mobile = checkMobile();

    // biome-ignore lint/suspicious/noExplicitAny: iOS-specific API
    const DeviceMotionEventClass = DeviceMotionEvent as any;

    // Check if permission API exists (iOS 13+)
    const hasPermissionAPI =
      typeof DeviceMotionEventClass.requestPermission === "function";

    if (hasPermissionAPI && mobile) {
      setPermissionState("needs-permission");
    } else {
      // Non-iOS or older iOS or desktop - permission not needed, events fire automatically
      setPermissionState("granted");
    }

    // Low-pass filter for smoothing (0.02 = very smooth, 0.06 = more responsive)
    // Slightly reduced to 0.05 to catch jitter at direction changes without adding lag
    const smoothingFactor = 0.05;
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
          smoothedDegrees =
            smoothedDegrees * (1 - smoothingFactor) + degrees * smoothingFactor;
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
      setFadePhase("idle");
      setOverlayState("hidden");
    }
  }, [activeSet, imageSets, resolveInitialSet]);

  const activeImages = useMemo(() => {
    if (imageSets.length === 0) {
      return [] as string[];
    }
    const selected = imageSets.find((set) => set.name === activeSet);
    return selected?.images ?? imageSets[0]?.images ?? [];
  }, [activeSet, imageSets]);

  // Get transition duration based on current phase
  const getTransitionDuration = () => {
    if (fadePhase === "fading-in") return FADE_IN_DURATION_MS;
    if (fadePhase === "fading-to-black") return FADE_TO_BLACK_DURATION_MS;
    if (fadePhase === "holding") return 0; // No transition during hold
    if (fadePhase === "fading-out") return FADE_OUT_DURATION_MS;
    return FADE_IN_DURATION_MS;
  };

  // Overlay styles based on state
  const overlayStyles: React.CSSProperties = {
    transitionDuration: `${getTransitionDuration()}ms`,
    transitionProperty: "opacity, background-color",
    transitionTimingFunction: "linear",
  };

  const overlayClass = cx(
    "pointer-events-none absolute inset-0",
    overlayState === "hidden" && "opacity-0 bg-black",
    overlayState === "half" && "opacity-50 bg-black",
    overlayState === "full" && "opacity-100 bg-black",
    overlayState === "fading" && "opacity-0 bg-black"
  );

  // Preload images for a given set
  const preloadImages = useCallback(
    (setName: string): Promise<void> => {
      const targetSet = imageSets.find((s) => s.name === setName);
      if (!targetSet) return Promise.resolve();

      return Promise.all(
        targetSet.images.map(
          (src) =>
            new Promise<void>((resolve) => {
              const img = new window.Image();
              img.onload = () => resolve();
              img.onerror = () => resolve(); // Continue even if one fails
              img.src = src;
            })
        )
      ).then(() => {});
    },
    [imageSets]
  );

  const startTransition = useCallback(
    (target: string) => {
      if (fadePhase !== "idle" || target === activeSet) {
        return;
      }
      // Step 1: Show 50% blur overlay first (don't change image yet)
      setPendingSet(target);
      setHighlightSet(target);
      setRevealReady(false);
      setOverlayState("half");
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
      // Step 2: After overlay reaches 50%, start preloading images
      const timer = window.setTimeout(() => {
        setFadePhase("loading");
      }, FADE_IN_DURATION_MS);
      return () => window.clearTimeout(timer);
    }

    if (fadePhase === "fading-to-black") {
      // Step 4: Fade from 50% to 100% opaque black
      setOverlayState("full");
      const timer = window.setTimeout(() => {
        setFadePhase("holding");
      }, FADE_TO_BLACK_DURATION_MS);
      return () => window.clearTimeout(timer);
    }

    if (fadePhase === "holding") {
      // Step 5: Hold at 100% black, swap images NOW
      if (pendingSet) {
        setActiveSet(pendingSet);
        setPendingSet(null);
      }
      const timer = window.setTimeout(() => {
        setFadePhase("fading-out");
      }, HOLD_DURATION_MS);
      return () => window.clearTimeout(timer);
    }

    if (fadePhase === "fading-out") {
      // Step 6: Fade out from 100% to 0%
      setOverlayState("fading");
      const timer = window.setTimeout(() => {
        setFadePhase("idle");
        setRevealReady(false);
        setOverlayState("hidden");
      }, FADE_OUT_DURATION_MS);
      return () => window.clearTimeout(timer);
    }
    return;
  }, [fadePhase, pendingSet]);

  const handleCanvasReady = useCallback(() => {
    setRevealReady(true);
    setIsInitialLoading(false);
  }, []);

  // Step 3: During loading phase, preload images then proceed
  useEffect(() => {
    if (fadePhase === "loading" && pendingSet) {
      preloadImages(pendingSet).then(() => {
        setRevealReady(true);
        setFadePhase("fading-to-black");
      });
    }
  }, [fadePhase, pendingSet, preloadImages]);

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
      <ZoomCanvas
        enabled={audioStarted}
        images={activeImages}
        isMobile={isMobile}
        onReady={handleCanvasReady}
        onZoomChange={updatePlaybackRate}
        orientation={audioStarted ? orientation : null}
        rawOrientation={audioStarted ? rawOrientation : null}
      />

      <div className={overlayClass} style={overlayStyles} />

      {/* Mute button - top right */}
      {audioStarted && (
        <button
          aria-label={isMuted ? "Unmute" : "Mute"}
          className="absolute top-4 right-4 z-40 flex h-14 w-14 cursor-pointer items-center justify-center rounded-full bg-black/50 p-3 backdrop-blur-md transition-all hover:scale-110 hover:bg-black/70 active:scale-95"
          onClick={toggleMute}
          style={{ boxShadow: "0 0 0 4px rgba(0, 0, 0, 0.2)" }}
          type="button"
        >
          <Image
            alt={isMuted ? "Unmute" : "Mute"}
            className="select-none"
            height={20}
            src={isMuted ? "/volume-on.svg" : "/volume-off.svg"}
            width={20}
          />
        </button>
      )}

      {/* Circular ring selector */}
      {mounted && (
        <div
          className="absolute flex items-center justify-center"
          onPointerLeave={audioStarted ? handlePointerLeave : undefined}
          style={{
            left: "50%",
            bottom: "2rem",
            transform: "translateX(-50%)",
            width: OUTER_RADIUS * 2,
            height: OUTER_RADIUS * 2,
          }}
        >
          {/* Clickable overlay to start audio - only visible before audio starts */}
          {!audioStarted && (
            <button
              aria-label="Start experience"
              className="absolute inset-0 z-50 cursor-pointer rounded-full"
              onClick={startAudio}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
              }}
              type="button"
            />
          )}
          {/* Ring background - only the ring band, not the center */}
          <div
            className="pointer-events-none absolute rounded-full transition-opacity duration-300"
            style={{
              width: OUTER_RADIUS * 2,
              height: OUTER_RADIUS * 2,
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              background: `radial-gradient(circle, rgba(0, 0, 0, 0.5) 0px, rgba(0, 0, 0, 0.5) ${OUTER_RADIUS}px, transparent ${OUTER_RADIUS}px)`,
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              opacity:
                !audioStarted ||
                isHovered ||
                isDragging ||
                showRingAfterStart ||
                !hideRing
                  ? 1
                  : 0,
              zIndex: 1,
              boxShadow: "0 0 0 4px rgba(0, 0, 0, 0.2)",
            }}
          />

          {/* Permanent slot circle at selected position (bottom) - black transparent */}
          <div
            className="pointer-events-none absolute rounded-full transition-opacity duration-300"
            style={{
              width: `${BUTTON_RADIUS * 2}px`,
              height: `${BUTTON_RADIUS * 2}px`,
              left: "50%",
              top: "50%",
              transform: `translate(calc(-50% + 0px), calc(-50% + ${BUTTON_CIRCLE_RADIUS}px))`,
              background: `radial-gradient(circle, rgba(0, 0, 0, 0.6) 0px, rgba(0, 0, 0, 0.6) ${OUTER_RADIUS}px, transparent ${OUTER_RADIUS}px)`,
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              opacity: audioStarted ? 1 : 0,
              zIndex: 2,
              boxShadow: "0 0 0 4px rgba(0, 0, 0, 0.2)",
            }}
          />

          {/* Rotating container for image buttons only */}
          <div
            className="absolute inset-0 touch-none transition-opacity duration-300"
            onPointerCancel={handlePointerUp}
            onPointerDown={audioStarted ? showRingTemporarily : undefined}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onWheel={handleWheel}
            ref={ringRef}
            style={{
              touchAction: "none",
              transform: `rotate(${-ringRotation}rad)`,
              pointerEvents: audioStarted ? "auto" : "none",
              cursor: isDragging ? "grabbing" : isHovered ? "grab" : "default",
              zIndex: 3,
            }}
          >
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
              // Before audio starts, show all items. After audio starts, show on hover/drag or if selected
              // Group visibility: outer circle, buttons, and SVG all use the same condition
              const groupVisible =
                !audioStarted ||
                isHovered ||
                isDragging ||
                showRingAfterStart ||
                !hideRing;
              const shouldShow = audioStarted
                ? groupVisible || isAtBottom
                : true;
              // Allow dragging any visible image when ring is visible, or the selected image always
              // Before audio starts, don't allow dragging (just clicking to start)
              const isDraggable = audioStarted
                ? isAtBottom ||
                  ((isHovered || isDragging || !hideRing) && shouldShow)
                : false;

              return (
                <div
                  className="absolute transition-opacity duration-300"
                  key={set.name}
                  onPointerDown={isDraggable ? handlePointerDown : undefined}
                  onPointerEnter={
                    audioStarted && isAtBottom ? handlePointerEnter : undefined
                  }
                  style={{
                    width: `${BUTTON_RADIUS * 2}px`,
                    height: `${BUTTON_RADIUS * 2}px`,
                    left: "50%",
                    top: "50%",
                    transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) rotate(${itemAngle - Math.PI / 2}rad)`,
                    zIndex: isAtBottom ? 10 : 1,
                    opacity: isAtBottom ? 1 : groupVisible ? 1 : 0,
                    pointerEvents:
                      isAtBottom || (isDraggable && groupVisible)
                        ? "auto"
                        : "none",
                    cursor: isDragging
                      ? "grabbing"
                      : isDraggable
                        ? "grab"
                        : "default",
                  }}
                >
                  <div
                    className={cx(
                      "relative h-full w-full overflow-hidden rounded-full bg-black/50",
                      isDragging && isAtBottom ? "cursor-grabbing" : ""
                    )}
                  >
                    {preview ? (
                      <Image
                        alt={label}
                        className="h-full w-full select-none object-cover"
                        draggable={false}
                        fill
                        priority={isAtBottom}
                        sizes={`${BUTTON_RADIUS * 2}px`}
                        src={preview}
                        style={{ pointerEvents: "none" }}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Tap to start text - shown before audio starts */}
          {!audioStarted && (
            <div
              className="pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-300"
              style={{
                left: "50%",
                top: "50%",
                transform: "translate(-50%, -50%)",
                zIndex: 5,
              }}
            >
              <span className="font-medium text-white/80 text-xs uppercase">
                Tap to start
              </span>
            </div>
          )}

          {/* Center logo - Dream Journey */}
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-300"
            style={{
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -40%)",
              opacity:
                audioStarted &&
                (isHovered || isDragging || showRingAfterStart || !hideRing)
                  ? 0.7
                  : 0,
              zIndex: 4,
            }}
          >
            <Image
              alt="Dream Journey"
              className="select-none"
              height={22}
              src="/dream-journey.svg"
              style={{
                pointerEvents: "none",
                transform: "scale(1.6) translateY(-8px)",
              }}
              width={34}
            />
          </div>
        </div>
      )}

      {/* Initial loading overlay */}
      <div
        className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-black transition-opacity duration-700"
        style={{
          opacity: isInitialLoading || !minLoadingTimePassed ? 1 : 0,
        }}
      >
        <span
          className="text-white/70"
          style={{
            fontFamily:
              'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            fontSize: "1rem",
            letterSpacing: "0.05em",
          }}
        >
          Dreaming
          <span
            style={{
              display: "inline-block",
              width: "1.5ch",
              textAlign: "left",
            }}
          >
            {".".repeat(dotCount)}
          </span>
        </span>
      </div>
    </div>
  );
}
