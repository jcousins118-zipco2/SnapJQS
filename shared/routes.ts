import { z } from 'zod';
import { insertHistorySchema, history } from './schema';

export const errorSchemas = {
  validation: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
};

export const api = {
  canonical: {
    process: {
      method: 'POST' as const,
      path: '/api/canonicalize',
      input: z.object({
        data: z.unknown(),
      }),
      responses: {
        200: z.object({
          canonical: z.string(),
          hash: z.string(),
          valid: z.boolean(),
        }),
        400: z.object({
          message: z.string(),
          error: z.string().optional(),
        }),
      },
    },
    sign: {
      method: 'POST' as const,
      path: '/api/sign',
      input: z.object({
        data: z.unknown(),
        kid: z.string(),
        keyHex: z.string(),
      }),
      responses: {
        200: z.object({
          receipt_sig: z.object({
            kid: z.string(),
            sig_hex: z.string(),
          }),
          canonical: z.string(),
        }),
        400: z.object({
          message: z.string(),
          error: z.string().optional(),
        }),
      },
    },
    verify: {
      method: 'POST' as const,
      path: '/api/verify',
      input: z.object({
        data: z.unknown(),
        receipt_sig: z.object({
          kid: z.string(),
          sig_hex: z.string(),
        }),
        kidToKeyHex: z.record(z.string()),
      }),
      responses: {
        200: z.object({
          valid: z.boolean(),
          canonical: z.string().optional(),
        }),
        400: z.object({
          message: z.string(),
          error: z.string().optional(),
        }),
      },
    },
    history: {
      method: 'GET' as const,
      path: '/api/history',
      responses: {
        200: z.array(z.custom<typeof history.$inferSelect>()),
      },
    },
    decide: {
      method: 'POST' as const,
      path: '/api/decide',
      input: z.object({
        requiredPredicates: z.array(z.string()),
        predicateResults: z.record(z.string()),
        forceEscalate: z.boolean().optional(),
      }),
      responses: {
        200: z.object({
          verdict: z.enum(['ALLOW', 'BLOCK', 'ESCALATE']),
          blockingPredicates: z.array(z.string()),
          predicateResults: z.record(z.enum(['PROVEN', 'DISPROVEN', 'UNKNOWN', 'ABSTAIN'])),
        }),
        400: z.object({
          message: z.string(),
          error: z.string().optional(),
        }),
      },
    },
  },
  session: {
    run: {
      method: 'POST' as const,
      path: '/api/session/run',
      input: z.object({
        caseId: z.string(),
        requiredPredicates: z.array(z.string()),
        jurorInputs: z.array(z.object({
          jurorId: z.string(),
          rawText: z.string(),
        })),
        signerKid: z.string(),
        signerKeyHex: z.string(),
        forceEscalate: z.boolean().optional(),
      }),
      responses: {
        200: z.object({
          verdict: z.string(),
          blockingPredicates: z.array(z.string()),
          predicateResults: z.record(z.string()),
          diagnostics: z.object({
            jurorsTotal: z.number(),
            jurorsParsed: z.number(),
            jurorsEmpty: z.number(),
            citationEnforcement: z.object({
              downgradedDisprovenMissingVerdictCode: z.number(),
              downgradedDisprovenMissingCitations: z.number(),
              downgradedDisprovenInvalidCitations: z.number(),
              kept: z.number(),
            }),
          }),
          receipt: z.record(z.unknown()),
        }),
        400: z.object({
          message: z.string(),
          error: z.string().optional(),
        }),
      },
    },
  },
  contract: {
    buildPrompt: {
      method: 'POST' as const,
      path: '/api/contract/build-prompt',
      input: z.object({
        role: z.string(),
        caseId: z.string(),
        predicates: z.array(z.string()),
        evidenceIndex: z.record(z.unknown()),
      }),
      responses: {
        200: z.object({
          prompt: z.string(),
          contractVersion: z.string(),
        }),
        400: z.object({
          message: z.string(),
          error: z.string().optional(),
        }),
      },
    },
    normalizeOutput: {
      method: 'POST' as const,
      path: '/api/contract/normalize',
      input: z.object({
        rawText: z.string(),
        allowedPredicates: z.array(z.string()),
      }),
      responses: {
        200: z.object({
          outputs: z.array(z.object({
            predicateId: z.string(),
            status: z.string(),
            verdictCode: z.string(),
            citedEvidenceIds: z.array(z.string()),
          })),
        }),
        400: z.object({
          message: z.string(),
          error: z.string().optional(),
        }),
      },
    },
    processResponse: {
      method: 'POST' as const,
      path: '/api/contract/process',
      input: z.object({
        rawText: z.string(),
        allowedPredicates: z.array(z.string()),
      }),
      responses: {
        200: z.object({
          outputs: z.array(z.object({
            predicateId: z.string(),
            status: z.string(),
            verdictCode: z.string(),
            citedEvidenceIds: z.array(z.string()),
          })),
          diagnostics: z.object({
            downgradedDisprovenMissingVerdictCode: z.number(),
            downgradedDisprovenMissingCitations: z.number(),
            downgradedDisprovenInvalidCitations: z.number(),
            kept: z.number(),
          }),
        }),
        400: z.object({
          message: z.string(),
          error: z.string().optional(),
        }),
      },
    },
  },
  evidence: {
    register: {
      method: 'POST' as const,
      path: '/api/evidence',
      input: z.object({
        evidenceType: z.enum(['TEXT', 'JSON', 'BINARY', 'SNAPSHOT', 'LOG']),
        payloadBase64: z.string(),
        meta: z.record(z.unknown()).optional(),
      }),
      responses: {
        200: z.object({
          evidenceId: z.string(),
          evidenceType: z.enum(['TEXT', 'JSON', 'BINARY', 'SNAPSHOT', 'LOG']),
          payloadSha256: z.string(),
          meta: z.record(z.unknown()),
          createdTs: z.number(),
        }),
        400: z.object({
          message: z.string(),
          error: z.string().optional(),
        }),
      },
    },
    get: {
      method: 'GET' as const,
      path: '/api/evidence/:id',
      responses: {
        200: z.object({
          evidenceId: z.string(),
          evidenceType: z.enum(['TEXT', 'JSON', 'BINARY', 'SNAPSHOT', 'LOG']),
          payloadSha256: z.string(),
          meta: z.record(z.unknown()),
          createdTs: z.number(),
        }),
        404: z.object({
          message: z.string(),
        }),
      },
    },
    getPayload: {
      method: 'GET' as const,
      path: '/api/evidence/:id/payload',
      responses: {
        200: z.object({
          payloadBase64: z.string(),
        }),
        404: z.object({
          message: z.string(),
        }),
      },
    },
    index: {
      method: 'GET' as const,
      path: '/api/evidence-index',
      responses: {
        200: z.object({
          rootHash: z.string(),
          evidence: z.record(z.object({
            type: z.string(),
            payload_sha256: z.string(),
            meta: z.record(z.unknown()),
            created_ts: z.number(),
          })),
          payloadsShared: z.boolean(),
        }),
      },
    },
    validateCitations: {
      method: 'POST' as const,
      path: '/api/evidence/validate-citations',
      input: z.object({
        citedIds: z.array(z.string()),
      }),
      responses: {
        200: z.object({
          valid: z.boolean(),
          missingIds: z.array(z.string()).optional(),
        }),
      },
    },
  },
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}
