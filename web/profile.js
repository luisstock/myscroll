// The reader's profile (Settings → Your profile) as a prompt-ready paragraph. No imports, so Node can load it too;
// model.js re-exports readerProfile.
export const DEFAULT_ABOUT = "A Portuguese motion designer who reads in English before bed. Into After Effects and motion design, local and frontier AI, gravel cycling and technique, random curiosities (Reddit TIL, old Cracked), tech, science, design.";

// settings: { profile?: { about, avoid } } -> "The reader: …\nAvoid: …"
export function readerProfile(settings) {
  const p = settings?.profile ?? {};
  const about = String(p.about ?? "").trim() || DEFAULT_ABOUT;
  const avoid = String(p.avoid ?? "").trim();
  return `The reader: ${about}${avoid ? `\nAvoid: ${avoid}` : ""}`;
}
