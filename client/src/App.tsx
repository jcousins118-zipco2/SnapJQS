import { useEffect, useMemo, useRef, useState } from "react";

type Domain =
  | "Everyday"
  | "Infrastructure"
  | "Technology"
  | "Policy"
  | "Finance"
  | "Design"
  | "Code"
  | "Research"
  | "Other";

type Focus =
  | "Feasibility"
  | "Plan"
  | "Options"
  | "Risk"
  | "Cost"
  | "Time"
  | "Impact"
  | "Safety"
  | "Quality"
  | "Evidence";

type IfResult =
  | { status: "ok"; ifLine: string; thenLine: string; rulesOutLine: string }
  | { status: "insufficient"; message: string; prompts: string[] };

const DOMAINS: Domain[] = [
  "Everyday",
  "Infrastructure",
  "Technology",
  "Policy",
  "Finance",
  "Design",
  "Code",
  "Research",
  "Other",
];

const FOCUSES: Focus[] = [
  "Feasibility",
  "Plan",
  "Options",
  "Risk",
  "Cost",
  "Time",
  "Impact",
  "Safety",
  "Quality",
  "Evidence",
];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function gateRulesOut(ifText: string, rulesOutText: string): string {
  const ifClean = (ifText || "").toLowerCase();
  const roClean = (rulesOutText || "").trim();

  if (!roClean) return "";

  const hasQuote = roClean.includes('"') || roClean.includes("\u201C") || roClean.includes("\u201D");
  if (hasQuote) return roClean;

  const tokens = ifClean
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const stop = new Set([
    "if","then","must","should","could","would","is","are","be","been","being",
    "a","an","the","and","or","to","of","in","on","for","with","without","under",
    "this","that","these","those","what","follows"
  ]);

  const key = Array.from(new Set(tokens)).filter(t => t.length >= 5 && !stop.has(t));
  if (key.length === 0) return "";

  const roLower = roClean.toLowerCase();
  const hits = key.filter(k => roLower.includes(k)).length;

  return hits >= 1 ? roClean : "";
}

async function runIfSpaceAPI(question: string, domain: Domain, focus: Focus, field: string, mode: "STRICT" | "ANALYZE"): Promise<IfResult> {
  try {
    const response = await fetch("/api/ifspace/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, domain, focus, field, mode }),
    });

    if (!response.ok) {
      return {
        status: "insufficient",
        message: "Something went wrong. Try again.",
        prompts: ["Rephrase your question"],
      };
    }

    const json = await response.json();

    if (json.status === "ok") {
      const raw = {
        ifLine: json.stands,
        thenLine: json.follows,
        rulesOutLine: json.rulesOut,
      };
      const safeRulesOut = gateRulesOut(raw.ifLine, raw.rulesOutLine);
      return {
        status: "ok",
        ...raw,
        rulesOutLine: safeRulesOut,
      };
    } else {
      return {
        status: "insufficient",
        message: json.message || "Not enough information yet.",
        prompts: json.prompts || ["Add more detail"],
      };
    }
  } catch {
    return {
      status: "insufficient",
      message: "Connection issue. Try again.",
      prompts: ["Check your connection"],
    };
  }
}

function normalizeText(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function appendDedup(prev: string, add: string) {
  const p = normalizeText(prev);
  const a = normalizeText(add);
  if (!a) return prev;

  if (p && p.toLowerCase().endsWith(a.toLowerCase())) return prev;

  const collapsed = a.replace(/(\b\w+\b(?:\s+\b\w+\b){0,6})\s+\1(\s+\1)+/gi, "$1");
  return (p ? p + " " : "") + normalizeText(collapsed);
}

type SpotlightRect = { top: number; left: number; width: number; height: number } | null;

export default function App() {
  const [question, setQuestion] = useState("");
  const [domain, setDomain] = useState<Domain>("Everyday");
  const [focus, setFocus] = useState<Focus>("Feasibility");
  const [mode, setMode] = useState<"STRICT" | "ANALYZE">("STRICT");

  const [field, setField] = useState("");
  const [fieldEnabled, setFieldEnabled] = useState(false);

  const [thinking, setThinking] = useState(false);
  const [thinkingSteps, setThinkingSteps] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<IfResult | null>(null);
  const [verdictBanner, setVerdictBanner] = useState("");

  const [optionsOpen, setOptionsOpen] = useState(false);

  const [voiceSupported, setVoiceSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recogRef = useRef<any>(null);
  const lastFinalRef = useRef<string>("");
  const stopTimerRef = useRef<any>(null);

  const [helpOpen, setHelpOpen] = useState(false);
  const [helpStep, setHelpStep] = useState(0);
  const [spot, setSpot] = useState<SpotlightRect>(null);

  const refAsk = useRef<HTMLTextAreaElement | null>(null);
  const refSpeak = useRef<HTMLButtonElement | null>(null);
  const refOptions = useRef<HTMLButtonElement | null>(null);
  const refConsider = useRef<HTMLButtonElement | null>(null);
  const refResult = useRef<HTMLDivElement | null>(null);

  const canRun = useMemo(() => question.trim().length > 0 && !thinking && !applying, [question, thinking, applying]);
  const markPulsing = thinking || applying;

  useEffect(() => {
    if (domain === "Research") {
      setFieldEnabled(true);
    }
  }, [domain]);

  const helpSteps = useMemo(
    () => [
      { title: "1) Ask naturally", body: "Type a normal question. No special format.", getEl: () => refAsk.current },
      { title: "2) Or speak", body: "Tap Speak, say one sentence, then it stops.", getEl: () => refSpeak.current },
      { title: "3) Options (optional)", body: "Pick a domain & focus. Keep it light.", getEl: () => refOptions.current },
      { title: "4) Consider", body: "Tap Consider. The 'if' mark pulses while it thinks.", getEl: () => refConsider.current },
      { title: "5) Result", body: "One clean line. If it's not settled, it asks for one missing piece.", getEl: () => refResult.current },
    ],
    []
  );

  function closeHelp() {
    setHelpOpen(false);
    setSpot(null);
  }

  function openHelp() {
    setHelpStep(0);
    setHelpOpen(true);
  }

  function computeSpotlight() {
    if (!helpOpen) return;
    const step = helpSteps[helpStep];
    const el = step?.getEl?.();
    if (!el) {
      setSpot(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 10;
    setSpot({
      top: Math.max(8, r.top - pad),
      left: Math.max(8, r.left - pad),
      width: Math.min(window.innerWidth - 16, r.width + pad * 2),
      height: Math.min(window.innerHeight - 16, r.height + pad * 2),
    });

    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {}
  }

  useEffect(() => {
    if (!helpOpen) return;
    computeSpotlight();
    const on = () => computeSpotlight();
    window.addEventListener("resize", on);
    window.addEventListener("scroll", on, true);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("scroll", on, true);
    };
  }, [helpOpen, helpStep]);

  useEffect(() => {
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) return;

    setVoiceSupported(true);
    const r = new SR();
    r.continuous = false;
    r.interimResults = false;
    r.lang = "en-GB";

    r.onresult = (event: any) => {
      try {
        const text = event?.results?.[0]?.[0]?.transcript ?? "";
        const finalText = normalizeText(text);
        if (!finalText) return;
        if (finalText.toLowerCase() === lastFinalRef.current.toLowerCase()) return;
        lastFinalRef.current = finalText;
        setQuestion((q) => appendDedup(q, finalText));
      } finally {
        setListening(false);
      }
    };

    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);

    recogRef.current = r;

    return () => {
      try {
        r.stop?.();
      } catch {}
    };
  }, []);

  function startVoice() {
    if (!voiceSupported || !recogRef.current) return;
    try {
      lastFinalRef.current = "";
      setListening(true);
      recogRef.current.start();

      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
      stopTimerRef.current = setTimeout(() => {
        try {
          recogRef.current?.stop?.();
        } catch {}
      }, 6000);
    } catch {
      setListening(false);
    }
  }

  function stopVoice() {
    try {
      recogRef.current?.stop?.();
    } catch {}
    setListening(false);
  }

  function toggleVoice() {
    if (listening) stopVoice();
    else startVoice();
  }

  function beginThinking() {
    setThinking(true);
    setThinkingSteps([]);
    setResult(null);
    setVerdictBanner("");
  }

  function endThinking() {
    setThinking(false);
  }

  // Detect "not settled" style responses
  function looksLikeNotSettled(text: string | undefined): boolean {
    if (!text) return false;
    const t = text.toLowerCase();
    const needles = [
      "not settled",
      "more constraints",
      "requires human",
      "human decision",
      "value judgment",
      "policy judgment",
      "escalate",
      "cannot conclude",
      "needs more detail",
      "not enough information",
      "cannot decide",
      "need more information before",
      "before a conclusion can follow",
    ];
    return needles.some((n) => t.includes(n));
  }

  // Split response into { content, verdictText }
  function splitContentAndVerdict(rawText: string): { content: string; verdictText: string } {
    const text = (rawText ?? "").trim();
    if (!text) return { content: "", verdictText: "" };

    // If whole thing is short and verdict-like, treat as verdict-only
    const isVerdictOnly =
      looksLikeNotSettled(text) && text.length < 220;

    if (isVerdictOnly) {
      return { content: "", verdictText: text };
    }

    // Try to split off verdict sentence at end
    const verdictPatterns = [
      /(?:^|\n)\s*then\s+more\s+constraints\s+are\s+needed[\s\S]*$/i,
      /(?:^|\n)\s*then\s+this\s+is\s+a\s+value\s+judg(e)?ment[\s\S]*$/i,
      /(?:^|\n)\s*then\s+.*requires\s+human\s+decision[\s\S]*$/i,
      /(?:^|\n)\s*this\s+is\s+a\s+value\s+judg(e)?ment[\s\S]*$/i,
      /(?:^|\n)\s*not\s+settled\s+yet[\s\S]*$/i,
      /(?:^|\n)\s*more\s+constraints\s+are\s+needed[\s\S]*$/i,
    ];

    for (const re of verdictPatterns) {
      const m = text.match(re);
      if (m && m.index != null && m.index > 0) {
        const content = text.slice(0, m.index).trim();
        const verdictText = text.slice(m.index).trim();
        if (content.length > 80) return { content, verdictText };
      }
    }

    return { content: text, verdictText: "" };
  }

  // Merge for mode: in ANALYZE, content always wins if present
  function mergeForMode(
    rawText: string
  ): { content: string; verdictText: string } {
    const split = splitContentAndVerdict(rawText);

    if (mode === "ANALYZE") {
      // ANALYZE LET-THROUGH: if content exists, show it. Verdict becomes banner.
      if (split.content) {
        return { content: split.content, verdictText: split.verdictText };
      }
      return { content: "", verdictText: split.verdictText || rawText };
    }

    // STRICT mode only (ANALYZE already returned above): verdict can block
    if (looksLikeNotSettled(split.verdictText || rawText)) {
      return { content: "", verdictText: split.verdictText || rawText };
    }
    return { content: split.content || rawText, verdictText: split.verdictText };
  }

  async function runConsideration() {
    beginThinking();
    setVerdictBanner("");

    const addStep = (step: string) => setThinkingSteps((prev) => [...prev, step]);

    addStep("Framing the question...");
    await sleep(400);

    addStep(mode === "ANALYZE" ? "Entering ANALYZE mode..." : "Entering STRICT mode...");
    await sleep(300);

    addStep("Consulting primary juror...");
    
    let r = await runIfSpaceAPI(question, domain, focus, fieldEnabled ? field : "", mode);
    
    // Get raw response text
    const rawText = r.status === "ok" 
      ? `${r.ifLine}\n${r.thenLine}\n${r.rulesOutLine}` 
      : r.message;

    // Split content and verdict for mode
    const { content, verdictText } = mergeForMode(rawText);

    // In ANALYZE mode with content, we have substance
    if (mode === "ANALYZE" && content) {
      addStep("Structured content extracted.");
      await sleep(200);
      
      if (verdictText) {
        addStep("Verdict demoted to banner note.");
        setVerdictBanner(verdictText);
      }
      
      // Rebuild result with split content
      if (r.status === "ok") {
        r = { ...r, ifLine: content, thenLine: "", rulesOutLine: "" };
      }
    }
    
    if (r.status === "ok") {
      addStep("Verifying conclusion...");
      await sleep(250);
      addStep("Checking for gaps...");
      await sleep(200);
      addStep("Verdict reached.");
    } else {
      addStep("More detail needed.");
    }

    await sleep(300);
    setResult(r);
    endThinking();
  }

  async function onRun() {
    if (!canRun) return;
    await runConsideration();
  }

  function backOneStage() {
    setResult(null);
  }

  async function onDoneOptions() {
    setOptionsOpen(false);
    setApplying(true);
    await sleep(450);
    setApplying(false);

    if (result) await runConsideration();
  }

  const showField = domain === "Research" || fieldEnabled;

  return (
    <div className="wrap">
      <style>{css}</style>

      {/* Header */}
      <div className="header">
        <div className={markPulsing ? "mark markPulse" : "mark"} aria-label="if">
          if
        </div>

        <div className="brand">
          <div className="brandTop">Quiet decisions.</div>
          <div className="brandSub">Clear conditions.</div>
        </div>

        <button className="pill" onClick={openHelp} data-testid="button-demo-help">
          Demo help ▸
        </button>

        <button className="pill" ref={refOptions as any} onClick={() => setOptionsOpen(true)} data-testid="button-options">
          Options ▸
        </button>
      </div>

      {/* Main card */}
      <div className="card">
        <textarea
          ref={refAsk}
          className="textarea"
          placeholder="Ask it naturally…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={thinking || applying}
          data-testid="input-question"
        />

        <div className="row">
          <div className="leftHint">{voiceSupported ? (listening ? "Listening…" : "Tap to speak") : ""}</div>

          {voiceSupported && (
            <button
              ref={refSpeak}
              className={listening ? "btnSoft btnSoftOn" : "btnSoft"}
              onClick={toggleVoice}
              data-testid="button-voice"
            >
              {listening ? "Stop" : "Speak"}
            </button>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 8, marginBottom: 8 }}>
          <button
            type="button"
            onClick={() => setMode("STRICT")}
            aria-pressed={mode === "STRICT"}
            style={{
              padding: "8px 12px",
              borderRadius: 999,
              border: "1px solid rgba(0,0,0,0.15)",
              background: mode === "STRICT" ? "rgba(0,0,0,0.08)" : "transparent",
              fontWeight: 600,
            }}
            data-testid="button-mode-strict"
          >
            STRICT (IF)
          </button>

          <button
            type="button"
            onClick={() => setMode("ANALYZE")}
            aria-pressed={mode === "ANALYZE"}
            style={{
              padding: "8px 12px",
              borderRadius: 999,
              border: "1px solid rgba(0,0,0,0.15)",
              background: mode === "ANALYZE" ? "rgba(0,0,0,0.08)" : "transparent",
              fontWeight: 600,
            }}
            data-testid="button-mode-analyze"
          >
            ANALYZE (Long-form)
          </button>
        </div>

        <button
          ref={refConsider}
          className={canRun ? "btnPrimary" : "btnPrimary btnDisabled"}
          onClick={onRun}
          disabled={!canRun}
          data-testid="button-consider"
        >
          Consider
        </button>
      </div>

      {/* Thinking */}
      {(thinking || applying) && (
        <div className="status">
          <div className="statusTitle">{thinking ? "Considering…" : "Applying…"}</div>
          <div className="statusSub">Slow and deliberate.</div>
          {thinkingSteps.length > 0 && (
            <ul className="thinkingSteps" data-testid="thinking-steps">
              {thinkingSteps.map((step, i) => (
                <li key={i} className="thinkingStep">{step}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {thinking && (
        <div
          style={{
            maxWidth: 560,
            margin: "16px auto 0",
            padding: "14px 18px",
            borderRadius: 12,
            background: "rgba(120, 180, 255, 0.12)",
            border: "1px solid rgba(120, 180, 255, 0.35)",
            fontSize: 14,
            color: "#3a5a8a",
          }}
          data-testid="thinking-banner"
        >
          <strong>Considering…</strong>
          <div style={{ marginTop: 6, opacity: 0.8 }}>
            We're holding the assumptions steady and checking what follows.
          </div>
        </div>
      )}

      {/* Result */}
      {result && !thinking && !applying && (
        <div className="resultCard" ref={refResult} data-testid="result-card">
          {result.status === "ok" ? (
            <>
              <div className="result">
                <p data-testid="text-result-stands"><strong>If</strong> {result.ifLine}</p>
                <p data-testid="text-result-follows"><strong>Then</strong> {result.thenLine}</p>
                {result.rulesOutLine ? (
                  <p data-testid="text-result-rules-out"><strong>This rules out</strong> {result.rulesOutLine}</p>
                ) : null}
              </div>

              <div className="actions">
                <button className="btnSoft" onClick={backOneStage} data-testid="button-back">
                  Back one stage
                </button>
                <button className="btnPrimary" onClick={() => setOptionsOpen(true)} data-testid="button-add-detail">
                  Add detail
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="resultTitle">Not settled yet</div>
              <div className="muted">{result.message}</div>

              <div className="miniLabel">Quick prompts</div>
              <ul className="list">
                {result.prompts.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>

              <div className="actions">
                <button className="btnSoft" onClick={backOneStage} data-testid="button-back">
                  Back one stage
                </button>
                <button className="btnPrimary" onClick={() => setOptionsOpen(true)} data-testid="button-add-detail">
                  Add detail
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Verdict Banner (ANALYZE mode - demoted verdict) */}
      {verdictBanner && !thinking && !applying && (
        <div
          className="verdictBanner"
          style={{
            maxWidth: 560,
            margin: "12px auto 0",
            padding: "10px 14px",
            borderRadius: 10,
            background: "rgba(0,0,0,0.04)",
            border: "1px solid rgba(0,0,0,0.12)",
            fontSize: 14,
            opacity: 0.85,
            color: "#5a5a5a",
          }}
          data-testid="verdict-banner"
        >
          {verdictBanner}
        </div>
      )}

      {/* Options Drawer (simplified) */}
      {optionsOpen && (
        <div className="sheetWrap" role="dialog" aria-modal="true">
          <div className="sheetBackdrop" onClick={() => setOptionsOpen(false)} />
          <div className="sheet">
            <div className="sheetTop">
              <div className="sheetTitle">Options</div>
              <button className="x" onClick={() => setOptionsOpen(false)} aria-label="close" data-testid="button-close-options">
                ×
              </button>
            </div>

            <div className="sheetHint">
              Light touch. You don't need to fill everything in.
            </div>

            <div className="row2">
              <div className="block">
                <div className="miniLabel">Domain</div>
                <select className="select" value={domain} onChange={(e) => setDomain(e.target.value as Domain)} data-testid="select-domain">
                  {DOMAINS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>

              <div className="block">
                <div className="miniLabel">Focus</div>
                <select className="select" value={focus} onChange={(e) => setFocus(e.target.value as Focus)} data-testid="select-focus">
                  {FOCUSES.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Field of study: only when Research OR user asks */}
            <div className="spacer" />

            {domain !== "Research" && !fieldEnabled && (
              <button
                className="btnSoft wide"
                onClick={() => setFieldEnabled(true)}
                title="Optional"
                data-testid="button-add-field"
              >
                + Add field of study (optional)
              </button>
            )}

            {showField && (
              <div className="fieldBox">
                <div className="miniLabel">Field of study</div>
                <input
                  className="input"
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                  placeholder="e.g., archaeology, biochemistry…"
                  data-testid="input-field"
                />
                <div className="tinyMuted">Only if it helps. One or two words is enough.</div>

                {domain !== "Research" && (
                  <button
                    className="linkBtn"
                    onClick={() => {
                      setFieldEnabled(false);
                      setField("");
                    }}
                    data-testid="button-remove-field"
                  >
                    Remove field
                  </button>
                )}
              </div>
            )}

            <div className="spacer" />

            <button className="btnPrimary" onClick={onDoneOptions} data-testid="button-done">
              Done
            </button>
          </div>
        </div>
      )}

      {/* Demo Help (Guided Walkthrough) */}
      {helpOpen && (
        <div className="helpWrap" role="dialog" aria-modal="true">
          <div className="helpDim" onClick={closeHelp} />

          {spot && (
            <div
              className="spotBox"
              style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
            />
          )}

          <div className="helpCard">
            <div className="helpTitle">{helpSteps[helpStep]?.title}</div>
            <div className="helpBody">{helpSteps[helpStep]?.body}</div>

            <div className="helpControls">
              <button
                className={helpStep === 0 ? "btnSoft btnDisabled2" : "btnSoft"}
                onClick={() => setHelpStep((s) => Math.max(0, s - 1))}
                disabled={helpStep === 0}
                data-testid="button-help-back"
              >
                Back
              </button>

              <button className="btnSoft" onClick={closeHelp} data-testid="button-help-close">
                Close
              </button>

              <button
                className="btnPrimary helpNext"
                onClick={() => {
                  if (helpStep >= helpSteps.length - 1) closeHelp();
                  else setHelpStep((s) => Math.min(helpSteps.length - 1, s + 1));
                }}
                data-testid="button-help-next"
              >
                {helpStep >= helpSteps.length - 1 ? "Done" : "Next"}
              </button>
            </div>

            <div className="helpDots">
              {helpSteps.map((_, i) => (
                <div key={i} className={i === helpStep ? "dot dotOn" : "dot"} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const css = `
:root{
  --bg1: rgba(255, 214, 214, 0.62);
  --bg2: rgba(255, 245, 235, 0.72);
  --bg3: rgba(240, 248, 255, 0.70);
  --ink: #15131A;
  --muted: #6E6A78;
  --card: rgba(255,255,255,0.72);
  --card2: rgba(255,255,255,0.86);
  --line: rgba(20,20,30,0.08);
  --shadow: 0 18px 60px rgba(20,20,30,0.10);
  --r: 22px;

  --p1: rgba(255, 214, 200, 0.95);
  --p2: rgba(255, 235, 210, 0.95);
  --pBorder: rgba(40,30,30,0.12);
}

html,body{height:100%;margin:0}
.wrap{
  min-height:100vh;
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
  background: radial-gradient(1200px 800px at 20% 0%, var(--bg1) 0%, var(--bg2) 35%, var(--bg3) 75%, #fff 100%);
  padding: 18px 14px 70px;
}

.header{
  max-width: 560px;
  margin: 0 auto;
  display:flex;
  align-items:center;
  gap: 10px;
  flex-wrap: wrap;
}

.mark{
  width: 44px; height: 44px;
  display:grid; place-items:center;
  border-radius: 18px;
  background: rgba(255,255,255,0.80);
  box-shadow: 0 10px 30px rgba(20,20,30,0.10);
  font-weight: 900;
  user-select:none;
}

.markPulse{ animation: pulse 1.8s ease-in-out infinite; }
@keyframes pulse{
  0%{transform: scale(1); opacity:1}
  50%{transform: scale(1.05); opacity:.86}
  100%{transform: scale(1); opacity:1}
}

.brand{flex:1; min-width: 160px;}
.brandTop{font-weight:900; font-size:14px}
.brandSub{color: var(--muted); font-size:13px; margin-top:2px}

.pill{
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.70);
  padding: 10px 12px;
  border-radius: 999px;
  font-weight: 900;
  font-size: 13px;
  cursor: pointer;
}

.card{
  max-width:560px;
  margin: 14px auto 0;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r);
  box-shadow: var(--shadow);
  padding: 16px;
}

.textarea{
  width: 100%;
  height: 150px;
  resize: none;
  border-radius: 18px;
  border: 1px solid var(--line);
  background: var(--card2);
  padding: 14px;
  font-size: 14px;
  outline: none;
  box-sizing: border-box;
}

.row{
  display:flex;
  align-items:center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
}

.leftHint{
  color: var(--muted);
  font-size: 12px;
  font-weight: 900;
}

.btnSoft{
  border-radius: 16px;
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.78);
  padding: 12px 14px;
  font-weight: 950;
  font-size: 13px;
  min-width: 110px;
  cursor: pointer;
}
.btnSoft.wide{ width: 100%; min-width: auto; }

.btnSoftOn{
  border-color: rgba(255, 190, 170, 0.55);
  box-shadow: 0 10px 24px rgba(255, 185, 165, 0.22);
}

.btnPrimary{
  border-radius: 18px;
  border: 1px solid var(--pBorder);
  background: linear-gradient(90deg, var(--p1), var(--p2));
  color: #1B1418;
  padding: 14px 18px;
  font-weight: 950;
  font-size: 14px;
  cursor: pointer;
}

.btnDisabled{ opacity: 0.55; cursor: not-allowed; }
.btnDisabled2{ opacity: 0.45; }

.card .btnPrimary{
  width: 100%;
  margin-top: 12px;
}

.status{
  max-width:560px;
  margin: 14px auto 0;
  background: rgba(255,255,255,0.62);
  border: 1px solid var(--line);
  border-radius: var(--r);
  box-shadow: var(--shadow);
  padding: 14px 16px;
}
.statusTitle{ font-weight: 950; font-size: 13px; }
.statusSub{ margin-top: 4px; font-size: 13px; color: var(--muted); font-weight: 900; }

.thinkingSteps{
  list-style: none;
  padding: 0;
  margin: 12px 0 0 0;
}
.thinkingStep{
  font-size: 12px;
  color: var(--muted);
  padding: 4px 0;
  opacity: 0;
  animation: fadeInStep 0.3s ease forwards;
}
.thinkingStep:nth-child(1){ animation-delay: 0s; }
.thinkingStep:nth-child(2){ animation-delay: 0.1s; }
.thinkingStep:nth-child(3){ animation-delay: 0.2s; }
.thinkingStep:nth-child(4){ animation-delay: 0.3s; }
.thinkingStep:nth-child(5){ animation-delay: 0.4s; }
.thinkingStep:nth-child(6){ animation-delay: 0.5s; }
@keyframes fadeInStep{
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

.resultCard{
  max-width:560px;
  margin: 14px auto 0;
  background: rgba(255,255,255,0.72);
  border: 1px solid var(--line);
  border-radius: var(--r);
  box-shadow: var(--shadow);
  padding: 16px;
}

.result p { margin: 8px 0; font-size: 15px; font-weight: 900; line-height: 1.4; color: #3A3544; }
.result p strong { font-weight: 950; color: #6B5B7A; }

.resultTitle{ font-weight: 950; font-size: 16px; }
.muted{ color: var(--muted); font-weight: 900; margin-top: 8px; font-size: 13px; }
.miniLabel{ margin-top: 14px; font-size: 12px; color: var(--muted); font-weight: 950; letter-spacing: 0.02em; text-transform: uppercase; }
.list{ margin: 8px 0 0 18px; color: #2F2B38; font-weight: 900; font-size: 13px; }

.actions{
  display:flex;
  gap: 10px;
  justify-content: space-between;
  margin-top: 14px;
}
.actions .btnSoft,
.actions .btnPrimary{ width:auto; flex:1; }

/* Sheet */
.sheetWrap{ position: fixed; inset: 0; z-index: 50; }
.sheetBackdrop{ position:absolute; inset:0; background: rgba(20,20,30,0.22); }
.sheet{
  position:absolute;
  left: 12px; right: 12px; bottom: 12px;
  background: rgba(255,255,255,0.92);
  border: 1px solid var(--line);
  border-radius: 22px;
  box-shadow: 0 28px 90px rgba(20,20,30,0.18);
  padding: 14px;
  max-width: 560px;
  margin: 0 auto;
}
.sheetTop{ display:flex; align-items:center; justify-content: space-between; gap:10px; }
.sheetTitle{ font-weight: 950; font-size: 13px; }
.sheetHint{ margin-top: 8px; color: var(--muted); font-weight: 900; font-size: 12px; }

.x{
  width: 40px; height: 40px;
  border-radius: 16px;
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.8);
  font-size: 20px;
  font-weight: 950;
  cursor: pointer;
}

.row2{
  display:flex;
  gap: 10px;
  margin-top: 10px;
}
@media (max-width: 460px){ .row2{ flex-direction: column; } }

.block{ flex:1; }

.select,.input{
  width: 100%;
  border-radius: 16px;
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.86);
  padding: 12px 12px;
  font-weight: 900;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}

.spacer{ height: 12px; }
.tinyMuted{ margin-top: 6px; color: var(--muted); font-weight: 900; font-size: 12px; }

.fieldBox{
  border: 1px solid rgba(20,20,30,0.06);
  background: rgba(255,255,255,0.70);
  border-radius: 18px;
  padding: 12px;
}
.linkBtn{
  margin-top: 8px;
  background: transparent;
  border: none;
  color: rgba(40,30,30,0.65);
  font-weight: 950;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}

/* Demo Help */
.helpWrap{ position: fixed; inset: 0; z-index: 60; }
.helpDim{ position:absolute; inset:0; background: rgba(15,12,20,0.38); }

.spotBox{
  position: absolute;
  border-radius: 18px;
  border: 2px solid rgba(255,255,255,0.92);
  box-shadow: 0 0 0 6px rgba(255, 220, 210, 0.18), 0 24px 80px rgba(10,10,20,0.22);
  pointer-events: none;
  animation: spotPulse 1.8s ease-in-out infinite;
}
@keyframes spotPulse{
  0%{ transform: scale(1); opacity: 0.95; }
  50%{ transform: scale(1.01); opacity: 0.78; }
  100%{ transform: scale(1); opacity: 0.95; }
}

.helpCard{
  position: absolute;
  left: 12px; right: 12px; bottom: 12px;
  max-width: 560px;
  margin: 0 auto;
  background: rgba(255,255,255,0.92);
  border: 1px solid rgba(255,255,255,0.40);
  border-radius: 22px;
  box-shadow: 0 28px 90px rgba(20,20,30,0.22);
  padding: 14px;
}
.helpTitle{ font-weight: 950; font-size: 14px; }
.helpBody{ margin-top: 6px; color: #2D2733; font-weight: 900; font-size: 13px; line-height: 1.35; }

.helpControls{ display:flex; gap: 10px; margin-top: 12px; align-items: center; }
.helpNext{ flex: 1; }

.helpDots{ display:flex; gap: 6px; margin-top: 12px; justify-content: center; }
.dot{ width: 8px; height: 8px; border-radius: 999px; background: rgba(20,20,30,0.18); }
.dotOn{ background: rgba(20,20,30,0.42); }
`;
