import { PatternParam } from "@/src/params/shared/patternParam";
import { isVector4 } from "@/src/utils/object";
import { isPalette } from "@/src/params/palette/Palette";

// Composite params (palettes, colors) decompose into scalar components so
// each number can be scrubbed and automated individually; the composite
// itself is not automatable. Each component exposes a PatternParam<number>
// adapter whose getter/setter proxies into the live composite value, so
// scrubs and lane lines stay bound to the real data.
export type ParamComponent = {
  // Appended to the uniform name to form the automation lane key, e.g.
  // "u_palette.a.x".
  path: string;
  label: string;
  param: PatternParam<number>;
};

const PALETTE_VECTORS = ["a", "b", "c", "d"] as const;
const AXES = ["x", "y", "z"] as const;
const CHANNELS = ["Red", "Green", "Blue"] as const;
const VECTOR4_LABELS = ["Red", "Green", "Blue", "Alpha"] as const;

export const getParamComponents = (
  param: PatternParam,
): ParamComponent[] | null => {
  const { value } = param;

  if (isPalette(value)) {
    const components: ParamComponent[] = [];
    for (const vector of PALETTE_VECTORS) {
      AXES.forEach((axis, index) => {
        const label = `${vector.toUpperCase()} ${CHANNELS[index]}`;
        components.push({
          path: `${vector}.${axis}`,
          label,
          param: {
            name: `${param.name} ${label}`,
            get value() {
              return value[vector][axis];
            },
            set value(next: number) {
              value[vector][axis] = next;
            },
          } as PatternParam<number>,
        });
      });
    }
    return components;
  }

  if (isVector4(value)) {
    return (["x", "y", "z", "w"] as const).map((axis, index) => ({
      path: axis,
      label: VECTOR4_LABELS[index],
      param: {
        name: `${param.name} ${VECTOR4_LABELS[index]}`,
        get value() {
          return value[axis];
        },
        set value(next: number) {
          value[axis] = next;
        },
        min: 0,
        max: 1,
      } as PatternParam<number>,
    }));
  }

  return null;
};
