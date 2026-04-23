/**
 * tools/run-local.ts
 *
 * Runnable harness for JQS v0.
 *
 * What it does:
 * - Creates an EvidenceRegistry and registers a couple evidence blobs
 * - Defines required predicates
 * - Prints a juror prompt you can paste into an LLM
 * - Lets you paste juror JSON responses back in (manual workflow)
 * - Runs the session orchestrator
 * - Prints verdict + signed receipt
 * - Writes audit log to audit/jqs_audit.jsonl
 *
 * How to run:
 *   npx tsx tools/run-local.ts
 *
 * Note:
 * - No APIs required
 * - This is a manual "human-in-the-loop" juror workflow
 */

import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { EvidenceRegistry, EvidenceType } from "../server/evidence";
import { buildJurorPrompt } from "../server/contract";
import { runSession, JurorInput } from "../server/orchestrator";
import { verifyReceipt } from "../server/signer";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

async function readMultiline(prompt: string): Promise<string> {
  console.log(prompt);
  console.log("(Paste JSON. Type END on its own line to finish.)");

  const lines: string[] = [];

  return new Promise((resolve) => {
    const listener = (line: string) => {
      if (line.trim() === "END") {
        rl.removeListener("line", listener);
        resolve(lines.join("\n").trim());
      } else {
        lines.push(line);
      }
    };
    rl.on("line", listener);
  });
}

async function main(): Promise<void> {
  // --- Config ---
  const caseId = "demo_case";
  const requiredPredicates = [
    "REPLAY_SAFE",
    "ROLLBACK_SAFE",
    "CITATION_GATING_WORKS",
  ];

  // Demo signer (DO NOT use this key in real life)
  const signerKid = "jqs-k1";
  const signerKey = Buffer.from("dev-secret-change-me", "utf-8");

  const auditPath = "audit/jqs_audit.jsonl";

  // --- Evidence Registry ---
  const reg = new EvidenceRegistry({ allowPayloadShare: false });

  // Add some demo evidence items (the content doesn't matter; IDs do)
  const ev1 = reg.register({
    evidenceType: EvidenceType.TEXT,
    payload: Buffer.from("Test log: replay prevention check passed in prior run."),
    meta: { name: "replay_test_log", source: "demo" },
  });
  const ev2 = reg.register({
    evidenceType: EvidenceType.TEXT,
    payload: Buffer.from("Rollback scenario: system blocks UNKNOWN required predicate."),
    meta: { name: "rollback_test_log", source: "demo" },
  });

  const evidenceIndex = reg.exportIndex();

  console.log("\n=== Evidence Registered ===");
  console.log("Evidence Root Hash:", evidenceIndex.rootHash);
  console.log("Evidence IDs:");
  console.log(" -", ev1.evidenceId, (ev1.meta as Record<string, unknown>).name);
  console.log(" -", ev2.evidenceId, (ev2.meta as Record<string, unknown>).name);

  // --- Build juror prompt ---
  const prompt = buildJurorPrompt({
    role: "GENERAL_JUROR",
    caseId,
    predicates: requiredPredicates,
    evidenceIndex: evidenceIndex as unknown as Record<string, unknown>,
  });

  console.log("\n=== Juror Prompt (paste this into your LLM juror) ===\n");
  console.log(prompt);

  // --- Collect juror outputs (manual paste) ---
  const jurors: JurorInput[] = [];

  console.log("\n=== Paste juror outputs ===");
  console.log("You can provide 1+ jurors. Leave juror_id empty to stop.\n");

  while (true) {
    const jurorId = (await ask("Juror ID (e.g. gpt, gemini, human1) [enter to finish]: ")).trim();
    if (!jurorId) {
      break;
    }
    const rawText = await readMultiline(`\nPaste output for juror '${jurorId}':`);
    jurors.push({ jurorId, rawText });
    console.log();
  }

  if (jurors.length === 0) {
    console.log("\nNo juror outputs provided. Exiting.");
    rl.close();
    return;
  }

  // --- Run session ---
  const result = runSession({
    caseId,
    requiredPredicates,
    jurorInputs: jurors,
    evidenceRegistry: reg,
    signerKid,
    signerKey,
    auditLogPath: auditPath,
    forceEscalate: false,
  });

  console.log("\n=== Session Result ===");
  console.log("Verdict:", result.verdict);
  console.log("Blocking predicates:", result.blockingPredicates);
  console.log("Predicate results:");
  for (const [k, v] of Object.entries(result.predicateResults)) {
    console.log(` - ${k}: ${v}`);
  }

  console.log("\n=== Signed Receipt ===");
  console.log("Unsigned output (what was signed):");
  
  // Reconstruct the unsigned payload from known fields (snake_case to match signed format)
  const unsignedPayload = {
    schema_version: "jqs.output.v0.7",
    case_id: caseId,
    verdict: result.verdict,
    blocking_predicates: result.blockingPredicates,
    predicate_results: result.predicateResults,
    evidence_registry_root: reg.rootHash(),
    diagnostics: {
      jurors_total: result.diagnostics.jurorsTotal,
      jurors_parsed: result.diagnostics.jurorsParsed,
      jurors_empty: result.diagnostics.jurorsEmpty,
      citation_enforcement: result.diagnostics.citationEnforcement,
    },
  };
  console.log(JSON.stringify(unsignedPayload, null, 2));
  console.log("\nreceipt_sig:", result.receipt);

  // --- Verify receipt (self-check) ---
  const ok = verifyReceipt(
    unsignedPayload,
    result.receipt as { kid: string; sig_hex: string },
    new Map([[signerKid, signerKey]])
  );
  console.log("\nReceipt verifies:", ok);

  // --- Write files for independent verification ---
  const outputDir = "output";
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const unsignedPath = path.join(outputDir, "unsigned.json");
  const receiptPath = path.join(outputDir, "receipt_sig.json");
  const keysPath = path.join(outputDir, "keys.json");

  fs.writeFileSync(unsignedPath, JSON.stringify(unsignedPayload, null, 2));
  fs.writeFileSync(receiptPath, JSON.stringify(result.receipt, null, 2));
  fs.writeFileSync(keysPath, JSON.stringify({
    [signerKid]: { encoding: "utf8", value: "dev-secret-change-me" }
  }, null, 2));

  console.log("\n=== Output Files (for independent verification) ===");
  console.log("Written:");
  console.log(" -", unsignedPath);
  console.log(" -", receiptPath);
  console.log(" -", keysPath);
  console.log("\nTo verify independently:");
  console.log(`  npx tsx tools/verify-receipt.ts ${unsignedPath} ${receiptPath} ${keysPath}`);

  console.log("\nAudit log written to:", auditPath);
  console.log("Done.");

  rl.close();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
