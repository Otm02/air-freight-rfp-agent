import {
  SERVICE_TYPES,
  type RequirementExtraction,
  type ServiceEvidence,
  type ServiceType,
} from "./types";

export const CONFIDENCE_THRESHOLD = 0.85;

interface ServicePatternRule {
  service: ServiceType;
  patternName: string;
  regex: RegExp;
  confidence: number;
}

const SERVICE_RULES: readonly ServicePatternRule[] = [
  // TEMP_CONTROLLED
  {
    service: "TEMP_CONTROLLED",
    patternName: "continuous_2_8_c_cold_chain",
    regex: /\bcontinuous 2-8\s*C cold chain\b/i,
    confidence: 0.99,
  },
  {
    service: "TEMP_CONTROLLED",
    patternName: "refrigerated_at_2_8_c",
    regex: /\brefrigerated at 2-8\s*C(?:,\s*including connections)?\b/i,
    confidence: 0.99,
  },
  {
    service: "TEMP_CONTROLLED",
    patternName: "between_2_and_8_degrees_c",
    regex: /\bbetween 2 and 8 degrees\s*C(?: for the whole trip)?\b/i,
    confidence: 0.99,
  },
  {
    service: "TEMP_CONTROLLED",
    patternName: "cold_chain_fallback",
    regex: /\b(?:2\s*[-–]\s*8\s*(?:°|deg(?:rees)?\s*)?C|cold[\s-]chain|refrigerated|temperature[\s-]controlled|chilled)\b/i,
    confidence: 0.9,
  },

  // DANGEROUS_GOODS
  {
    service: "DANGEROUS_GOODS",
    patternName: "approved_dangerous_goods_handling",
    regex: /\bapproved dangerous-goods handling\b/i,
    confidence: 0.99,
  },
  {
    service: "DANGEROUS_GOODS",
    patternName: "dangerous_goods_every_leg",
    regex: /\bdangerous-goods handling on every leg\b/i,
    confidence: 0.99,
  },
  {
    service: "DANGEROUS_GOODS",
    patternName: "classified_as_dangerous_goods",
    regex: /\bclassified as dangerous goods and needs the appropriate handling\b/i,
    confidence: 0.99,
  },
  {
    service: "DANGEROUS_GOODS",
    patternName: "dangerous_goods_fallback",
    regex: /\b(?:dangerous[\s-]goods(?:\s+handling)?|hazmat|hazardous materials?|DG\s+(?:handling|cargo|approved|certified))\b/i,
    confidence: 0.89,
  },

  // HIGH_VALUE_SECURITY
  {
    service: "HIGH_VALUE_SECURITY",
    patternName: "high_value_security_connecting",
    regex: /\bhigh-value security is needed,\s*including on connecting flights\b/i,
    confidence: 0.99,
  },
  {
    service: "HIGH_VALUE_SECURITY",
    patternName: "high_value_security_throughout",
    regex: /\bhigh-value security throughout\b/i,
    confidence: 0.99,
  },
  {
    service: "HIGH_VALUE_SECURITY",
    patternName: "high_value_secure_handling",
    regex: /\bhigh-value items,\s*so we need secure handling all the way\b/i,
    confidence: 0.99,
  },
  {
    service: "HIGH_VALUE_SECURITY",
    patternName: "high_value_fallback",
    regex: /\b(?:high[\s-]value(?:\s+(?:security|cargo|items?|goods))?|secure handling|armored(?:\s+transport)?|valuable cargo)\b/i,
    confidence: 0.89,
  },

  // FRAGILE
  {
    service: "FRAGILE",
    patternName: "contents_fragile_handling",
    regex: /\bcontents are fragile,\s*so please arrange fragile handling\b/i,
    confidence: 0.99,
  },
  {
    service: "FRAGILE",
    patternName: "fragile_every_leg",
    regex: /\bfragile on every leg\b/i,
    confidence: 0.99,
  },
  {
    service: "FRAGILE",
    patternName: "fragile_goods_throughout",
    regex: /\bfragile-goods handling throughout\b/i,
    confidence: 0.99,
  },
  {
    service: "FRAGILE",
    patternName: "fragile_fallback",
    regex: /\b(?:fragile(?:[\s-]goods)?(?:\s+handling)?|delicate(?:\s+(?:cargo|handling|goods))?)\b/i,
    confidence: 0.9,
  },

  // OVERSIZED
  {
    service: "OVERSIZED",
    patternName: "accommodate_oversized_cargo",
    regex: /\bflights that can accommodate oversized cargo\b/i,
    confidence: 0.99,
  },
  {
    service: "OVERSIZED",
    patternName: "oversized_capability_throughout",
    regex: /\boversized,\s*so please confirm oversized-cargo capability throughout\b/i,
    confidence: 0.99,
  },
  {
    service: "OVERSIZED",
    patternName: "oversized_handling_all_flights",
    regex: /\boversized-cargo handling on all flights\b/i,
    confidence: 0.99,
  },
  {
    service: "OVERSIZED",
    patternName: "oversized_fallback",
    regex: /\b(?:oversized(?:[\s-]cargo)?(?:\s+(?:handling|capability))?|out[\s-]of[\s-]gauge|OOG)\b/i,
    confidence: 0.89,
  },
];

const STANDARD_CARGO_RULES: readonly { regex: RegExp; confidence: number }[] = [
  {
    regex: /\bstandard general cargo is fine;\s*no special services needed\b/i,
    confidence: 0.99,
  },
  {
    regex: /\bnothing special is needed for this shipment,\s*just standard general cargo\b/i,
    confidence: 0.99,
  },
  {
    regex: /\bstandard general cargo with no additional services\b/i,
    confidence: 0.99,
  },
  {
    regex: /\b(?:standard general cargo|general cargo only|no special services(?:\s+(?:needed|required))?|nothing special(?:\s+(?:is\s+)?needed)?|no additional services)\b/i,
    confidence: 0.93,
  },
];

const UNMAPPED_PATTERNS: readonly RegExp[] = [
  /\bdry\s+ice\b/i,
  /\bdeep[\s-]?frozen\b/i,
  /\bfrozen\b/i,
  /-\s*20\s*(?:°|deg(?:rees)?\s*)?C\b/i,
  /\blive\s+animals?\b/i,
  /\bhuman\s+remains\b/i,
  /\bradioactive\b/i,
  /\blithium(?:\s+ion)?\s+batter(?:y|ies)\b/i,
  /\bcustoms\s+clearance\b/i,
];

const NEGATION_PREFIX_RE =
  /(?:^|[\s,;.(])(?:no|not|without|don't need|do not need|no need for|exclude|excluding)\s+(?:any\s+)?(?:special\s+)?$/i;

const EXPLICIT_LANE_RE = /\b([A-Z]{3})\s*(?:to|-|->|→)\s*([A-Z]{3})\b/g;

function isNegatedAt(text: string, index: number): boolean {
  const start = Math.max(0, index - 36);
  const prefix = text.slice(start, index);
  return NEGATION_PREFIX_RE.test(prefix);
}

export function extractRequirementsOffline(
  emailText: string,
  context?: { origin?: string; destination?: string },
): RequirementExtraction {
  const trimmed = emailText.trim();
  if (!trimmed) {
    return {
      requestedServices: [],
      evidence: [],
      standardCargoQuote: null,
      unmappedPhrases: [],
      warnings: ["Shipper email text is empty."],
      confidence: 0,
      needsHumanReview: true,
      reviewReason: "Shipper email text is empty.",
    };
  }

  const evidenceByService = new Map<
    ServiceType,
    { evidence: ServiceEvidence; confidence: number }
  >();
  const warnings: string[] = [];

  for (const rule of SERVICE_RULES) {
    if (evidenceByService.has(rule.service)) {
      continue;
    }
    const flags = rule.regex.flags.includes("g")
      ? rule.regex.flags
      : `${rule.regex.flags}g`;
    const globalRegex = new RegExp(rule.regex.source, flags);

    let match: RegExpExecArray | null;
    while ((match = globalRegex.exec(emailText)) !== null) {
      if (isNegatedAt(emailText, match.index)) {
        warnings.push(
          `Ignored negated phrase near "${match[0]}" for ${rule.service}.`,
        );
        continue;
      }
      evidenceByService.set(rule.service, {
        evidence: {
          service: rule.service,
          quote: match[0],
          matchedPattern: rule.patternName,
        },
        confidence: rule.confidence,
      });
      break;
    }
  }

  let standardCargoQuote: string | null = null;
  let standardCargoConfidence = 0;
  for (const rule of STANDARD_CARGO_RULES) {
    const match = rule.regex.exec(emailText);
    if (match) {
      standardCargoQuote = match[0];
      standardCargoConfidence = rule.confidence;
      break;
    }
  }

  const unmappedPhrases: string[] = [];
  for (const pat of UNMAPPED_PATTERNS) {
    const match = pat.exec(emailText);
    if (match && !isNegatedAt(emailText, match.index)) {
      unmappedPhrases.push(match[0]);
    }
  }

  if (context?.origin && context?.destination) {
    const expectedOrig = context.origin.trim().toUpperCase();
    const expectedDest = context.destination.trim().toUpperCase();
    const laneRegex = new RegExp(EXPLICIT_LANE_RE.source, "g");
    let laneMatch: RegExpExecArray | null;
    while ((laneMatch = laneRegex.exec(emailText)) !== null) {
      const mentionedOrig = laneMatch[1];
      const mentionedDest = laneMatch[2];
      if (
        mentionedOrig &&
        mentionedDest &&
        (mentionedOrig !== expectedOrig || mentionedDest !== expectedDest)
      ) {
        warnings.push(
          `Email mentions lane ${mentionedOrig}-${mentionedDest}, which differs from row ${expectedOrig}-${expectedDest}.`,
        );
      }
    }
  }

  const requestedServices = SERVICE_TYPES.filter((svc) =>
    evidenceByService.has(svc),
  );
  const evidence = requestedServices.map((svc) => {
    const entry = evidenceByService.get(svc);
    if (!entry) {
      throw new Error(`Missing evidence entry for ${svc}`);
    }
    return entry.evidence;
  });

  let confidence: number;
  const reviewReasons: string[] = [];

  if (evidence.length > 0 && standardCargoQuote !== null) {
    confidence = 0.4;
    reviewReasons.push(
      `Conflicting cues: email matched both standard cargo ("${standardCargoQuote}") and special requirements (${requestedServices.join(", ")}).`,
    );
  } else if (evidence.length > 0) {
    const minServiceConf = Math.min(
      ...requestedServices.map(
        (svc) => evidenceByService.get(svc)?.confidence ?? 0.85,
      ),
    );
    confidence = minServiceConf;
  } else if (standardCargoQuote !== null) {
    confidence = standardCargoConfidence;
  } else {
    confidence = 0.35;
    reviewReasons.push(
      "No recognizable special service or explicit standard-cargo statement found in email.",
    );
  }

  if (unmappedPhrases.length > 0) {
    confidence = Math.min(confidence, 0.45);
    reviewReasons.push(
      `Unmapped special requirement phrase(s) outside supported catalog: ${unmappedPhrases.map((p) => `"${p}"`).join(", ")}.`,
    );
  }

  if (warnings.length > 0) {
    confidence = Math.min(confidence, 0.7);
    reviewReasons.push(...warnings);
  }

  const needsHumanReview =
    confidence < CONFIDENCE_THRESHOLD || reviewReasons.length > 0;

  return {
    requestedServices,
    evidence,
    standardCargoQuote,
    unmappedPhrases,
    warnings,
    confidence: Number(confidence.toFixed(2)),
    needsHumanReview,
    reviewReason: reviewReasons.length > 0 ? reviewReasons.join(" ") : null,
  };
}
