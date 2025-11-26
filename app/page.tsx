/** biome-ignore-all lint/style/noMagicNumbers : Closer to the context*/
"use client";

import ZoomExperience, { type ImageSet } from "./zoom-experience";

const createImageSet = (name: string, count: number): ImageSet => ({
  name,
  images: Array.from({ length: count }, (_, index) => {
    const id = String(index + 1).padStart(2, "0");
    return `/images/${name}/${id}.png`;
  }),
});

const IMAGE_SETS: ImageSet[] = [
  createImageSet("animals", 13),
  createImageSet("street", 15),
  createImageSet("faces", 12),
  createImageSet("crystals", 12),
  createImageSet("mountains", 11),
  createImageSet("winter", 18),
];

export default function Page() {
  return (
    <ZoomExperience imageSets={IMAGE_SETS} initialSet={IMAGE_SETS[0]?.name} />
  );
}
