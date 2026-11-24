import type { z } from "zod";
import type {
  adoptSuggestionSchema, recommendationOutputSchema, reviseSuggestionSchema, suggestionConditionsSchema,
} from "./suggestion-schemas";

export const suggestionModeHeader = "X-Mille-Suggestion-Mode";
export type SuggestionMode = "sample" | "openai";

export type SuggestionConditions = z.output<typeof suggestionConditionsSchema>;
export type ReviseSuggestionInput = z.output<typeof reviseSuggestionSchema>;
export type AdoptSuggestionInput = z.output<typeof adoptSuggestionSchema>;

export type SuggestionCandidate = z.output<typeof recommendationOutputSchema>[number] & { id: string };
export type SuggestionFailure = "TIMEOUT" | "UNAVAILABLE" | "INVALID_OUTPUT";

export interface Suggestion {
  id: string;
  version: number;
  conditions: SuggestionConditions;
  candidates: SuggestionCandidate[];
  messages: string[];
  request: {
    id: string;
    status: "RUNNING" | "SUCCEEDED" | "FAILED" | "EXPIRED";
    failure: SuggestionFailure | null;
    message: string | null;
  };
}
