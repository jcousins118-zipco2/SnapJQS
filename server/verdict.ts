// =====================
// JQS Verdict Envelope (deterministic, inspectable, token-safe)
// =====================

export type VerdictStatus = "CONCLUDE" | "NEED_MORE_DETAIL" | "ESCALATE_HUMAN";

export type VerdictEnvelope = {
  status: VerdictStatus;
  then?: string;
  rules_out?: string[];
  need_detail?: string;
  citations: string[];
  votes?: string;
  model_id?: string;
};

function _norm(s: string): string {
  return (s || "").trim();
}

function _safeLower(s: string): string {
  return _norm(s).toLowerCase();
}

function _uniq(arr: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    const t = _norm(x);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function _extractJsonObject(raw: string): any | null {
  const s = raw.trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const maybe = s.slice(start, end + 1);
      try {
        return JSON.parse(maybe);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function _keywordsFromIf(ifText: string): string[] {
  const stop = new Set([
    "this","that","with","from","then","than","have","must","should","would","could",
    "into","over","under","when","where","what","which","while","your","youre","their",
    "there","been","being","will","only","also","very","just","most","more","less",
    "like","need","make","made","same","case","work","true","false"
  ]);
  const words = _safeLower(ifText)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !stop.has(w));
  return _uniq(words);
}

function _hasKeywordOverlap(ifText: string, thenText: string): boolean {
  const ifKeys = _keywordsFromIf(ifText);
  if (ifKeys.length === 0) return true;
  const hay = _safeLower(thenText);
  return ifKeys.some(k => hay.includes(k));
}

function _isGenericThen(thenText: string): boolean {
  const t = _safeLower(thenText);
  return (
    t.includes("underdetermined") ||
    t.includes("cannot be determined") ||
    t.includes("cannot be decided") ||
    t.includes("cannot decide") ||
    t.includes("needs more detail") ||
    t.includes("need more detail") ||
    t.includes("insufficient") ||
    t.includes("policy choice") ||
    t.includes("value choice") ||
    t.includes("must declare") ||
    t.includes("must specify") ||
    t.includes("escalate") ||
    t.includes("cannot justify by data alone")
  );
}

function _citationsAreFromIf(ifText: string, citations: string[]): boolean {
  const ifRaw = ifText || "";
  if (!ifRaw.trim()) return false;
  return citations.every(c => c && ifRaw.includes(c));
}

export function enforceRulesOutGate(currentIF: string, thenText: string, rulesOutText: string): { thenText: string; rulesOutText: string } {
  if (!rulesOutText) return { thenText, rulesOutText: "" };

  // Require a quoted cite inside RULES OUT
  const m = rulesOutText.match(/[""](.+?)[""]/);
  if (!m) return { thenText, rulesOutText: "" };

  const cite = m[1].trim();
  if (!cite) return { thenText, rulesOutText: "" };

  // Must be a literal substring of the current IF (case-insensitive)
  const ok = currentIF.toLowerCase().includes(cite.toLowerCase());
  if (!ok) return { thenText, rulesOutText: "" };

  return { thenText, rulesOutText };
}

function _makeNeedDetailFallback(ifText: string): string {
  return "What single constraint matters most here (cost, time, safety, or quality) — and what's the limit?";
}

export function normalizeVerdictEnvelope(
  ifText: string,
  rawJurorText: string,
  model_id?: string
): VerdictEnvelope {
  const parsed = _extractJsonObject(rawJurorText);

  if (!parsed || typeof parsed !== "object") {
    return {
      status: "NEED_MORE_DETAIL",
      need_detail: _makeNeedDetailFallback(ifText),
      citations: [],
      model_id,
    };
  }

  const status = _norm(parsed.status) as VerdictStatus;
  const thenLine = _norm(parsed.then);
  const rulesOutArr = Array.isArray(parsed.rules_out) ? parsed.rules_out.map(String) : [];
  const needDetail = _norm(parsed.need_detail);
  const citationsArr = Array.isArray(parsed.citations) ? parsed.citations.map(String) : [];
  const votes = _norm(parsed.votes);

  const citations = _uniq(citationsArr);
  let rules_out = _uniq(rulesOutArr);

  const okStatus: VerdictStatus =
    status === "CONCLUDE" || status === "NEED_MORE_DETAIL" || status === "ESCALATE_HUMAN"
      ? status
      : "NEED_MORE_DETAIL";

  const citations_ok = citations.length > 0 && _citationsAreFromIf(ifText, citations);
  if (!citations_ok) {
    rules_out = [];
  }

  let finalStatus: VerdictStatus = okStatus;
  let finalThen = thenLine;

  if (finalStatus === "CONCLUDE") {
    if (!finalThen) {
      finalStatus = "NEED_MORE_DETAIL";
    } else {
      const grounded = _hasKeywordOverlap(ifText, finalThen) || _isGenericThen(finalThen);
      if (!grounded) {
        finalStatus = "NEED_MORE_DETAIL";
        finalThen = "";
      }
    }
  }

  let finalNeed = needDetail;
  if (finalStatus === "NEED_MORE_DETAIL") {
    if (!finalNeed) finalNeed = _makeNeedDetailFallback(ifText);
  } else {
    finalNeed = "";
  }

  const out: VerdictEnvelope = {
    status: finalStatus,
    citations,
    model_id,
  };

  if (votes) out.votes = votes;

  if (finalStatus === "CONCLUDE") {
    out.then = finalThen;
    if (rules_out.length > 0) out.rules_out = rules_out;
  }

  if (finalStatus === "NEED_MORE_DETAIL") {
    out.need_detail = finalNeed;
  }

  if (finalStatus === "ESCALATE_HUMAN") {
    if (rules_out.length > 0) out.rules_out = rules_out;
  }

  return out;
}
