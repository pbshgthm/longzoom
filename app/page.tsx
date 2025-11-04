"use client";

import ZoomExperience, { type ImageSet } from "./zoom-experience";

const createImageSet = (name: string, count: number): ImageSet => ({
  name,
  images: Array.from({ length: count }, (_, index) => {
    const id = String(index + 1).padStart(2, "0");
    return `/images/${name}/${id}.png`;
  }),
});

const STREET_COUNT = 15;
const ANIMALS_COUNT = 13;
const FACES_COUNT = 12;

const IMAGE_SETS: ImageSet[] = [
  createImageSet("street", STREET_COUNT),
  createImageSet("animals", ANIMALS_COUNT),
  createImageSet("faces", FACES_COUNT),
];

export default function Page() {
  return (
    <ZoomExperience imageSets={IMAGE_SETS} initialSet={IMAGE_SETS[0]?.name} />
  );
}
