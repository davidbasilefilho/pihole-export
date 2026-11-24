import { Effect, Schema } from "effect";

import { FilterForm, ValidationError } from "./model";
import { needsHeavyQueryConfirmation, toQuerySpec, type QuerySpec } from "./query";

export type FilterAction = "query" | "export";
export interface FilterRequest {
  readonly action: FilterAction;
  readonly spec: QuerySpec;
}

export const prepareFilterRequest = (filters: FilterForm, action: FilterAction) =>
  Schema.decodeUnknownEffect(FilterForm)(filters).pipe(
    Effect.mapError((error) => new ValidationError({ message: String(error) })),
    Effect.flatMap(toQuerySpec),
    Effect.map((spec): FilterRequest => ({ action, spec })),
  );

export const dispatchFilterRequest = (
  request: FilterRequest,
  handlers: {
    readonly confirm: (request: FilterRequest) => void;
    readonly query: (spec: QuerySpec) => void;
    readonly export: (spec: QuerySpec) => void;
  },
  confirmed = false,
) => {
  if (!confirmed && needsHeavyQueryConfirmation(request.spec)) handlers.confirm(request);
  else handlers[request.action](request.spec);
};
