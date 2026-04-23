import { pgTable, text, serial, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

export const history = pgTable("history", {
  id: serial("id").primaryKey(),
  originalInput: text("original_input").notNull(),
  canonicalOutput: text("canonical_output").notNull(),
  sha256Hash: text("sha256_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertHistorySchema = createInsertSchema(history).omit({ 
  id: true, 
  createdAt: true 
});

export type HistoryItem = typeof history.$inferSelect;
export type InsertHistory = z.infer<typeof insertHistorySchema>;

// API Request/Response Types
export interface CanonicalizeRequest {
  data: unknown; // The raw JSON input
}

export interface CanonicalizeResponse {
  canonical: string;
  hash: string;
  valid: boolean;
  error?: string;
}

export interface SignRequest {
  data: unknown;
  kid: string;
  keyHex: string; // Hex-encoded key for transport
}

export interface SignResponse {
  receipt_sig: {
    kid: string;
    sig_hex: string;
  };
  canonical: string;
}

export interface VerifyRequest {
  data: unknown;
  receipt_sig: {
    kid: string;
    sig_hex: string;
  };
  kidToKeyHex: Record<string, string>; // Map of kid -> hex-encoded key
}

export interface VerifyResponse {
  valid: boolean;
  canonical?: string;
}

// Decision types
export type PredicateStatus = "PROVEN" | "DISPROVEN" | "UNKNOWN" | "ABSTAIN";
export type VerdictType = "ALLOW" | "BLOCK" | "ESCALATE";

export interface DecideRequest {
  requiredPredicates: string[];
  predicateResults: Record<string, string>;
  forceEscalate?: boolean;
}

export interface DecisionResponse {
  verdict: VerdictType;
  blockingPredicates: string[];
  predicateResults: Record<string, PredicateStatus>;
}

// Evidence types
export type EvidenceTypeValue = "TEXT" | "JSON" | "BINARY" | "SNAPSHOT" | "LOG";

export interface RegisterEvidenceRequest {
  evidenceType: EvidenceTypeValue;
  payloadBase64: string; // Base64-encoded payload for transport
  meta?: Record<string, unknown>;
}

export interface EvidenceRecordResponse {
  evidenceId: string;
  evidenceType: EvidenceTypeValue;
  payloadSha256: string;
  meta: Record<string, unknown>;
  createdTs: number;
}

export interface EvidenceIndexResponse {
  rootHash: string;
  evidence: Record<string, {
    type: string;
    payload_sha256: string;
    meta: Record<string, unknown>;
    created_ts: number;
  }>;
  payloadsShared: boolean;
}

export interface ValidateCitationsRequest {
  citedIds: string[];
}

export interface ValidateCitationsResponse {
  valid: boolean;
  missingIds?: string[];
}

// Contract types
export interface BuildPromptRequest {
  role: string;
  caseId: string;
  predicates: string[];
  evidenceIndex: Record<string, unknown>;
}

export interface BuildPromptResponse {
  prompt: string;
  contractVersion: string;
}

export interface NormalizeJurorOutputRequest {
  rawText: string;
  allowedPredicates: string[];
}

export interface RawJurorOutputItem {
  predicateId: string;
  status: string;
  verdictCode: string;
  citedEvidenceIds: string[];
}

export interface NormalizeJurorOutputResponse {
  outputs: RawJurorOutputItem[];
}

export interface ProcessJurorResponseRequest {
  rawText: string;
  allowedPredicates: string[];
}

export interface EnforcementDiagnosticsResponse {
  downgradedDisprovenMissingVerdictCode: number;
  downgradedDisprovenMissingCitations: number;
  downgradedDisprovenInvalidCitations: number;
  kept: number;
}

export interface ProcessJurorResponseResponse {
  outputs: RawJurorOutputItem[];
  diagnostics: EnforcementDiagnosticsResponse;
}

// Orchestrator types
export interface JurorInputItem {
  jurorId: string;
  rawText: string;
}

export interface RunSessionRequest {
  caseId: string;
  requiredPredicates: string[];
  jurorInputs: JurorInputItem[];
  signerKid: string;
  signerKeyHex: string;
  forceEscalate?: boolean;
}

export interface SessionDiagnosticsResponse {
  jurorsTotal: number;
  jurorsParsed: number;
  jurorsEmpty: number;
  citationEnforcement: EnforcementDiagnosticsResponse;
}

export interface SessionResultResponse {
  verdict: string;
  blockingPredicates: string[];
  predicateResults: Record<string, string>;
  diagnostics: SessionDiagnosticsResponse;
  receipt: Record<string, unknown>;
}

// Chat models for OpenAI integration
export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
