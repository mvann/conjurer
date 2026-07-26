import { patternFactories, playgroundPatterns } from "@/src/patterns/patterns";
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
