/**
 * JQS CODE CRYPT — INPUT / GATE / DISPATCH TRACE
 * Drop-in debugging instrumentation
 */

type CryptEvent =
  | "INCOMING_USER_TEXT"
  | "GATE_SNAPSHOT"
  | "MODEL_DISPATCH"
  | "MISMATCH_DETECTED";

function cryptLog(event: CryptEvent, payload: Record<string, unknown>) {
  console.log(
    "[JQS_CRYPT]",
    new Date().toISOString(),
    event,
    JSON.stringify(payload, null, 2)
  );
}

function containsConstraintKeyword(text: string): boolean {
  const keywords = [
    "constraint",
    "limit",
    "safety",
    "quality",
    "cost",
    "time",
    "verification",
    "anchor",
  ];
  const lower = (text || "").toLowerCase();
  return keywords.some(k => lower.includes(k));
}

/** HOOK 1: request intake - Call immediately after request parsing */
export function cryptIncoming(req: { path?: string; body?: Record<string, unknown> }) {
  cryptLog("INCOMING_USER_TEXT", {
    route: req?.path,
    mode: req?.body?.mode,
    rawText: req?.body?.question,
    hasAddDetail: Boolean(req?.body?.add_detail),
    addDetailValue: req?.body?.add_detail || null,
  });
}

/** HOOK 2: gate decision - Call at every gate decision */
export function cryptGate(
  gateName: string,
  state: {
    isSettled: boolean;
    missing: string[];
    resolvedFrom?: string;
  },
  userText: string,
  addDetail?: string
) {
  cryptLog("GATE_SNAPSHOT", {
    gateName,
    isSettled: state.isSettled,
    missing: state.missing,
    resolvedFrom: state.resolvedFrom || "unknown",
  });

  if (
    state.missing.length > 0 &&
    (containsConstraintKeyword(userText) ||
      containsConstraintKeyword(addDetail || ""))
  ) {
    cryptLog("MISMATCH_DETECTED", {
      gateName,
      missing: state.missing,
      evidence: {
        inUserText: containsConstraintKeyword(userText),
        inAddDetail: containsConstraintKeyword(addDetail || ""),
      },
    });
  }
}

/** HOOK 3: model dispatch - Call immediately before model invocation */
export function cryptDispatch(payload: {
  mode: string;
  model: string;
  finalPrompt: string;
}) {
  cryptLog("MODEL_DISPATCH", {
    mode: payload.mode,
    model: payload.model,
    finalPrompt: payload.finalPrompt,
  });
}

// Legacy exports for backward compatibility
export const crypt_logIncomingUserText = (text: string, meta?: Record<string, unknown>) => {
  cryptLog("INCOMING_USER_TEXT", { ...meta, rawText: text });
};

export const crypt_logGateSnapshot = (snapshot: { gateName: string; isSettled: boolean; missing: string[]; stateKeys?: string[]; state?: Record<string, unknown> }) => {
  cryptLog("GATE_SNAPSHOT", snapshot);
};

export const crypt_logModelDispatch = (dispatch: { finalPrompt: string; modelName?: string; mode?: string }) => {
  cryptLog("MODEL_DISPATCH", { mode: dispatch.mode, model: dispatch.modelName, finalPrompt: dispatch.finalPrompt });
};

export const crypt_detectMismatch = (userText: string, snapshot: { gateName: string; missing: string[] }) => {
  if (snapshot.missing.length > 0 && containsConstraintKeyword(userText)) {
    cryptLog("MISMATCH_DETECTED", {
      gateName: snapshot.gateName,
      missing: snapshot.missing,
      evidence: { inUserText: containsConstraintKeyword(userText) },
    });
  }
};
