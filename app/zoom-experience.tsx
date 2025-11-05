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
      <ZoomCanvas images={activeImages} onReady={handleCanvasReady} />
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
