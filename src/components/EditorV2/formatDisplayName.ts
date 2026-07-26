// "timeFactor" -> "Time Factor", "PulsePalette" -> "Pulse Palette",
// "fuzziness" -> "Fuzziness"; already-spaced names pass through (each word
// capitalized).
export const formatDisplayName = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
