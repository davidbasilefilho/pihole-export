import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Effect, Schema } from "effect"
import {
  ApiError,
  ApiErrorResponse,
  AuthResponse,
  ConnectionForm,
  DecodeError,
  NetworkError,
  Query,
  QueryResponse,
  Session,
  Suggestions,
  SuggestionsResponse,
  ValidationError,
} from "./model"
import { QuerySpec, serializeQuery } from "./query"

const LoginBody = Schema.Struct({ password: Schema.String, totp: Schema.optional(Schema.String) })
const TookOnly = Schema.Struct({ took: Schema.optional(Schema.Number) })

export interface AuthenticatedConnection {
  readonly baseUrl: string
  readonly session: Session
  readonly ownedSession: boolean
}

const decode = <A, I>(schema: Schema.Schema<A, I>, response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(schema)(response).pipe(
    Effect.mapError((error) => new DecodeError({ message: String(error) })),
  )

const execute = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* client.execute(request).pipe(
      Effect.retry({ times: 2 }),
      Effect.mapError(() => new NetworkError({ message: "Network request failed after 3 attempts" })),
    )
  })

const expect = <A, I>(schema: Schema.Schema<A, I>, request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const response = yield* execute(request)
    if (response.status >= 200 && response.status < 300) return yield* decode(schema, response)
    const failure = yield* decode(ApiErrorResponse, response)
    return yield* new ApiError({ status: response.status, key: failure.error.key, message: failure.error.message })
  })

const authenticated = (request: HttpClientRequest.HttpClientRequest, sid: string | null) =>
  sid === null ? request : HttpClientRequest.setHeader(request, "X-FTL-SID", sid)

const requireValidSession = (session: Session) =>
  session.valid
    ? Effect.succeed(session)
    : Effect.fail(new ApiError({ status: 401, key: "unauthorized", message: session.message ?? "Authentication failed" }))

export const authenticate = (baseUrl: string, form: ConnectionForm) =>
  Effect.gen(function* () {
    const endpoint = `${baseUrl}/api/auth`
    if (form.authMethod === "password") {
      const body = form.totp.trim() === ""
        ? { password: form.secret }
        : { password: form.secret, totp: form.totp.trim() }
      const request = yield* HttpClientRequest.post(endpoint).pipe(HttpClientRequest.schemaBodyJson(LoginBody)(body))
      const response = yield* expect(AuthResponse, request)
      const session = yield* requireValidSession(response.session)
      return { baseUrl, session, ownedSession: session.sid !== null } satisfies AuthenticatedConnection
    }
    const sid = form.authMethod === "session" ? form.secret.trim() : null
    if (form.authMethod === "session" && sid === "") {
      return yield* new ValidationError({ message: "Enter an existing Pi-hole session ID" })
    }
    const response = yield* execute(authenticated(HttpClientRequest.get(endpoint), sid)).pipe(
      Effect.flatMap((reply) => decode(AuthResponse, reply)),
    )
    const session = yield* requireValidSession(response.session)
    return { baseUrl, session: sid === null ? session : { ...session, sid }, ownedSession: false } satisfies AuthenticatedConnection
  })

export const logout = (connection: AuthenticatedConnection) =>
  connection.ownedSession && connection.session.sid !== null
    ? Effect.gen(function* () {
        const response = yield* execute(authenticated(HttpClientRequest.del(`${connection.baseUrl}/api/auth`), connection.session.sid))
        if (response.status === 204) return
        if (response.status === 404) {
          yield* decode(TookOnly, response)
          return
        }
        const failure = yield* decode(ApiErrorResponse, response)
        return yield* new ApiError({ status: response.status, key: failure.error.key, message: failure.error.message })
      })
    : Effect.void

export const fetchSuggestions = (connection: AuthenticatedConnection) =>
  expect(
    SuggestionsResponse,
    authenticated(HttpClientRequest.get(`${connection.baseUrl}/api/queries/suggestions`), connection.session.sid),
  ).pipe(Effect.map((response): Suggestions => response.suggestions))

const fetchPage = (connection: AuthenticatedConnection, spec: QuerySpec, start: number, cursor?: number) => {
  const url = `${connection.baseUrl}/api/queries?${serializeQuery(spec, start, cursor).toString()}`
  return expect(QueryResponse, authenticated(HttpClientRequest.get(url), connection.session.sid))
}

export const fetchAllQueries = (connection: AuthenticatedConnection, spec: QuerySpec) =>
  Effect.gen(function* () {
    const rows: Array<Query> = []
    let start = 0
    let cursor: number | undefined
    while (true) {
      const page = yield* fetchPage(connection, spec, start, cursor)
      if (cursor === undefined && page.cursor !== null) cursor = page.cursor
      rows.push(...page.queries)
      start += page.queries.length
      if (page.queries.length === 0 || page.queries.length < 10_000 || start >= page.recordsFiltered) return rows
    }
  })

export const HttpLive = FetchHttpClient.layer
