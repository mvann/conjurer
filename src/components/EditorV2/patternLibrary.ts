import { patternFactories, playgroundPatterns } from "@/src/patterns/patterns";
import { effectFactories, playgroundEffects } from "@/src/effects/effects";
import { Pattern } from "@/src/types/Pattern";

// playgroundPatterns[i] is patternFactories[i] instantiated, so zipping them
// gives us a name for each factory.
export const patternLibrary: { name: string; factory: () => Pattern }[] =
  playgroundPatterns.map((pattern, index) => ({
    name: pattern.name,
    factory: patternFactories[index],
  }));

export const patternFactoryByName = (name: string) =>
  patternLibrary.find((entry) => entry.name === name)?.factory;

// Effects are Patterns whose shaders read u_texture (the previous render
// stage) and transform it; the main app's catalog applies unchanged.
export const effectLibrary: { name: string; factory: () => Pattern }[] =
  playgroundEffects.map((effect, index) => ({
    name: effect.name,
    factory: effectFactories[index],
  }));

export const effectFactoryByName = (name: string) =>
  effectLibrary.find((entry) => entry.name === name)?.factory;
