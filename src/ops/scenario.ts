import type { Precedence, Role } from "./types";

/**
 * The exercise scenario: the island, its distribution points and what each
 * kind of cell can do. Everything here is invented.
 */

export const EXERCISE = { name: "Exercise ORANGE CLOUD", island: "Halcyon" } as const;

/** The eight distribution points (DPs) relief stores are delivered to. */
export const SITES = [
  { id: "alpha", name: "DP ALPHA", place: "Port Merrow" },
  { id: "bravo", name: "DP BRAVO", place: "Saltmarsh" },
  { id: "charlie", name: "DP CHARLIE", place: "Greywater" },
  { id: "delta", name: "DP DELTA", place: "Tollbridge" },
  { id: "echo", name: "DP ECHO", place: "Highfold" },
  { id: "foxtrot", name: "DP FOXTROT", place: "Ashcombe" },
  { id: "golf", name: "DP GOLF", place: "Marram Bay" },
  { id: "hotel", name: "DP HOTEL", place: "East Light" }
] as const;

export const SITE_IDS = SITES.map((s) => s.id) as [string, ...string[]];

interface StoreSeed {
  id: string;
  name: string;
  description: string;
  /** Starting pallets for [air, land] */
  stock: [number, number];
  /** Reserve for [air, land] */
  reserve: [number, number];
}

/** Both kinds of cell hold the same stores. A Land cell holds far more of them. */
const STORES: StoreSeed[] = [
  { id: "water", name: "Bottled water", description: "Drinking water, shrink-wrapped", stock: [12, 40], reserve: [2, 8] },
  { id: "rations", name: "Ration packs", description: "24-hour packs, no cooking needed", stock: [12, 30], reserve: [2, 6] },
  { id: "medical", name: "Medical supplies", description: "Dressings, fluids and basic medicines", stock: [10, 12], reserve: [3, 3] },
  { id: "shelter", name: "Shelter kits", description: "Tarpaulins, rope and tools", stock: [8, 20], reserve: [2, 4] },
  { id: "blankets", name: "Blankets", description: "Baled, 50 to a pallet", stock: [10, 24], reserve: [2, 4] },
  { id: "generators", name: "Generators", description: "Diesel sets for clinics and shelters", stock: [4, 8], reserve: [1, 2] },
  { id: "fuel", name: "Fuel", description: "Diesel in drums", stock: [6, 16], reserve: [2, 4] },
  { id: "sandbags", name: "Sandbags", description: "Filled and palletised", stock: [6, 40], reserve: [2, 8] }
];

export interface RoleConfig {
  role: Role;
  /** "Air cell" */
  label: string;
  /** The default callsign stem, before a team picks their own */
  callsign: string;
  /** What one task is called: a sortie or a convoy */
  lift: string;
  /** The most pallets one request can carry */
  maxPallets: number;
  /** What the board calls the "en_route" lane */
  enRouteLabel: string;
  /** One line on what this cell is good at, used in tool instructions */
  blurb: string;
}

export const ROLES: Record<Role, RoleConfig> = {
  air: {
    role: "air",
    label: "Air cell",
    callsign: "KESTREL",
    lift: "sortie",
    maxPallets: 6,
    enRouteLabel: "Airborne",
    blurb: "Flies stores to any distribution point, cut off or not. Fast, but a sortie lifts 6 pallets at most and nothing launches while flying is suspended."
  },
  land: {
    role: "land",
    label: "Land cell",
    callsign: "BADGER",
    lift: "convoy",
    maxPallets: 24,
    enRouteLabel: "On the road",
    blurb: "Moves stores by road. A convoy carries up to 24 pallets, but it can't reach a distribution point whose road is cut."
  }
};

export function storesFor(role: Role) {
  const i = role === "air" ? 0 : 1;
  return STORES.map((s) => ({ id: s.id, name: s.name, description: s.description, stock: s.stock[i], reserve: s.reserve[i] }));
}

/** Notes that arrive with surge requests, for a bit of colour. */
export const SURGE_NOTES = [
  "Clinic is running on battery power",
  "The shelter is the school hall",
  "Contact is the harbour master",
  "The water main is out",
  "About 200 people at this point",
  "Deliver to the church car park",
  "Road in is narrow: go steady",
  null,
  null,
  null
];

/** Surge requests are mostly routine, with the odd urgent one. */
export const SURGE_PRECEDENCE: Precedence[] = ["routine", "routine", "routine", "priority", "priority", "immediate"];

/** Stock never goes above this, however much is resupplied. */
export const MAX_STOCK = 99;
