import { Effect, Option, Stream, type Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { backend } from "./backend";
import type { ConnectionForm, Query, QueryResponse, Session, Suggestions } from "./model";
import type { QuerySpec } from "./query";

export type DomainMutationAction = "block" | "unblock";
export interface AuthenticatedConnection {
  readonly baseUrl: string;
  readonly session: Session;
  readonly ownedSession: boolean;
}
export const authenticate = (baseUrl: string, form: ConnectionForm) =>
  backend<AuthenticatedConnection>({ op: "auth", url: baseUrl, form });
export const logout = (connection: AuthenticatedConnection) =>
  backend<void>({ op: "logout", connection });
export const fetchSuggestions = (connection: AuthenticatedConnection) =>
  backend<Suggestions>({ op: "suggestions", connection });
export const mutateDomain = (
  connection: AuthenticatedConnection,
  domain: string,
  action: DomainMutationAction,
) => backend<void>({ op: "mutate", connection, domain, action });

export interface QueryPage {
  readonly queries: ReadonlyArray<Query>;
  readonly cursor: number | null;
  readonly recordsFiltered: number;
}

export const fetchQueryPage = (
  connection: AuthenticatedConnection,
  spec: QuerySpec,
  start: number,
  cursor?: number,
  length = 10_000,
) =>
  backend<Schema.Schema.Type<typeof QueryResponse>>({
    op: "page",
    connection,
    spec,
    start,
    cursor,
    length,
  });

interface PageState {
  readonly start: number;
  readonly cursor?: number;
}

export const streamQueryPages = (connection: AuthenticatedConnection, spec: QuerySpec) =>
  Stream.paginate<PageState, QueryPage, Error, never>({ start: 0 }, (state) =>
    fetchQueryPage(connection, spec, state.start, state.cursor).pipe(
      Effect.map((page) => {
        const nextStart = state.start + page.queries.length;
        const cursor = state.cursor ?? page.cursor ?? undefined;
        const done =
          page.queries.length === 0 ||
          page.queries.length < 10_000 ||
          nextStart >= page.recordsFiltered;
        const output: QueryPage = {
          queries: page.queries,
          cursor: page.cursor,
          recordsFiltered: page.recordsFiltered,
        };
        const nextState: PageState =
          cursor === undefined ? { start: nextStart } : { start: nextStart, cursor };
        return [[output], done ? Option.none<PageState>() : Option.some(nextState)] as const;
      }),
    ),
  );

export const fetchAllQueries = (connection: AuthenticatedConnection, spec: QuerySpec) =>
  streamQueryPages(connection, spec).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.queries)),
    Stream.runCollect,
  );

export const HttpLive = FetchHttpClient.layer;
