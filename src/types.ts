/** Input to the `briefing` workflow — one preflight weather briefing request. */
export type BriefingRequest = {
  departure: string;
  destination: string;
  alternate?: string;
  etdIso: string;
  flightRules: "VFR" | "IFR";
  aircraft?: string;
};

export type HazardSeverity = "low" | "moderate" | "high";

export type Hazard = {
  type: string;
  detail: string;
  severity: HazardSeverity;
};

export type Recommendation = "GO" | "GO_WITH_CAUTION" | "NO_GO";

/** Structured briefing produced by Claude for the initial weather picture. */
export type Briefing = {
  summary: string;
  hazards: Hazard[];
  recommendation: Recommendation;
  reasoning: string;
  validAsOfIso: string;
};

/**
 * Re-brief produced ~1h before departure. Same shape as Briefing, plus the
 * diff against the original: `recommendation` here is the *new* recommendation.
 */
export type ReBrief = Briefing & {
  changed: boolean;
  changeSummary: string;
};

/** Raw weather collected from aviationweather.gov, rendered per station group. */
export type WeatherBundle = {
  fetchedAtIso: string;
  metars: string[];
  tafs: string[];
  pireps: string[];
  sigmets: string[];
  gairmets: string[];
  /** Stations that were requested but returned no METAR / no TAF. */
  missingMetar: string[];
  missingTaf: string[];
};

export type BriefingPhase =
  | "FETCHING_WEATHER"
  | "AWAITING_ACK"
  | "WAITING_FOR_REBRIEF_WINDOW"
  | "REBRIEFING"
  | "AWAITING_REACK"
  | "RE_ACKNOWLEDGED"
  | "UNCHANGED_CONFIRMED";

/** What the `getStatus` handler returns — this powers the pilot UI. */
export type BriefingStatus = {
  phase: BriefingPhase | null;
  request: BriefingRequest | null;
  briefing: Briefing | null;
  rebrief: ReBrief | null;
};
