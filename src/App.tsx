/** @jsxImportSource @opentui/solid */
import { FileSystem, HttpClient } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { Button } from "@tuiparts/solid";
import { Effect, Fiber, Layer, ManagedRuntime, Schema } from "effect";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createStore } from "solid-js/store";

import {
  authenticate,
  AuthenticatedConnection,
  fetchAllQueries,
  fetchSuggestions,
  HttpLive,
  logout,
} from "./api";
import { writeCsv } from "./csv";
import {
  AuthMethod,
  ConnectionForm,
  FilterForm,
  Query,
  Suggestions,
  ValidationError,
} from "./model";
import {
  baseUrl,
  defaultFilename,
  needsHeavyQueryConfirmation,
  QuerySpec,
  toQuerySpec,
} from "./query";
import { theme } from "./theme";
import { defaultRange } from "./time";

type Screen =
  | "connect"
  | "filters"
  | "results"
  | "inspect"
  | "help"
  | "confirm"
  | "export"
  | "suggestions";
type SuggestionField = keyof Suggestions;
type ConnectFocus = "host" | "scheme" | "port" | "auth" | "secret" | "totp" | "connect";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type AppServices = HttpClient.HttpClient | FileSystem.FileSystem;

const runtime = ManagedRuntime.make(Layer.merge(HttpLive, BunFileSystem.layer));
const emptySuggestions: Suggestions = {
  domain: [],
  client_ip: [],
  client_name: [],
  upstream: [],
  type: [],
  status: [],
  reply: [],
  dnssec: [],
};

const fieldBg = (focused: boolean) => (focused ? theme.bgHighlight : theme.bgStripe);

function Field(props: {
  label: string;
  value: string;
  focused: boolean;
  placeholder?: string;
  secret?: boolean;
  width?: number;
  minWidth?: number;
  flexGrow?: number;
  onInput: (value: string) => void;
  onSubmit?: () => void;
}) {
  return (
    <box
      flexDirection="column"
      height={2}
      flexGrow={props.flexGrow ?? 1}
      minWidth={props.minWidth ?? 18}
      {...(props.width === undefined ? {} : { width: props.width })}>
      <text fg={props.focused ? theme.cyan : theme.fg}>{props.label}</text>
      <box backgroundColor={fieldBg(props.focused)} paddingLeft={1} height={1}>
        <input
          value={props.value}
          focused={props.focused}
          placeholder={props.placeholder ?? ""}
          width="100%"
          textColor={props.secret ? fieldBg(props.focused) : theme.fg}
          focusedTextColor={props.secret ? fieldBg(props.focused) : theme.fg}
          cursorColor={theme.blue}
          placeholderColor={theme.muted}
          onInput={(next) => props.onInput(next)}
          onSubmit={() => props.onSubmit?.()}
        />
        <text
          position="absolute"
          left={1}
          fg={theme.fg}
          content={props.secret ? "•".repeat(props.value.length) : ""}
        />
      </box>
    </box>
  );
}

function ActionButton(props: { label: string; focused?: boolean; onPress: () => void }) {
  return (
    <Button
      onPress={props.onPress}
      backgroundColor={props.focused ? theme.blue : theme.bgHighlight}>
      <text fg={props.focused ? theme.bgDark : theme.fg}> {props.label} </text>
    </Button>
  );
}

function KeyBar(props: { items: ReadonlyArray<readonly [string, string]> }) {
  return (
    <box height={1} width="100%" flexDirection="row" backgroundColor={theme.bgHighlight}>
      <For each={props.items}>
        {([key, label]) => (
          <box flexDirection="row" paddingRight={1} gap={1}>
            <text fg={theme.yellow}>{key}</text>
            <text fg={theme.muted}>{label} │</text>
          </box>
        )}
      </For>
    </box>
  );
}

const truncate = (value: string, width: number) =>
  value.length > width ? value.slice(0, Math.max(0, width - 1)) + "…" : value.padEnd(width);

export function App() {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  renderer.setBackgroundColor(theme.bg);

  const range = defaultRange();
  const [host, setHost] = createSignal("");
  const [scheme, setScheme] = createSignal<"http" | "https">("http");
  const [port, setPort] = createSignal("");
  const [authMethod, setAuthMethod] = createSignal<AuthMethod>("password");
  const [secret, setSecret] = createSignal("");
  const [totp, setTotp] = createSignal("");
  const connectionForm = (): Mutable<ConnectionForm> => ({
    host: host(),
    scheme: scheme(),
    port: port(),
    authMethod: authMethod(),
    secret: secret(),
    totp: totp(),
  });
  const [filters, setFilters] = createStore<Mutable<FilterForm>>({
    ...range,
    disk: false,
    domain: "",
    clientIp: "",
    clientName: "",
    upstream: "",
    type: "",
    status: "",
    reply: "",
    dnssec: "",
  });
  const [screen, setScreen] = createSignal<Screen>("connect");
  const [connectFocus, setConnectFocus] = createSignal<ConnectFocus>("host");
  const [returnScreen, setReturnScreen] = createSignal<Screen>("results");
  const [focus, setFocus] = createSignal(0);
  const [connection, setConnection] = createSignal<AuthenticatedConnection | null>(null);
  const [suggestions, setSuggestions] = createSignal<Suggestions>(emptySuggestions);
  const [suggestionField, setSuggestionField] = createSignal<SuggestionField | null>(null);
  const [suggestionIndex, setSuggestionIndex] = createSignal(0);
  const [rows, setRows] = createSignal<ReadonlyArray<Query>>([]);
  const [selected, setSelected] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [pendingSpec, setPendingSpec] = createSignal<QuerySpec | null>(null);
  const [activeSpec, setActiveSpec] = createSignal<QuerySpec | null>(null);
  const [exportPath, setExportPath] = createSignal("");
  let cancel: (() => void) | undefined;
  let runId = 0;

  const runEffect = <A, E>(
    effect: Effect.Effect<A, E, AppServices>,
    success: (value: A) => void,
  ) => {
    const id = ++runId;
    cancel?.();
    setBusy(true);
    setMessage("");
    const fiber = runtime.runFork(
      effect.pipe(
        Effect.tap((value) => Effect.sync(() => success(value))),
        Effect.catchAll((error) =>
          Effect.sync(() => setMessage(error instanceof Error ? error.message : String(error))),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (runId === id) setBusy(false);
          }),
        ),
      ),
    );
    cancel = () => Effect.runFork(Fiber.interruptFork(fiber));
  };

  const connect = () => {
    const parsed = Schema.decodeUnknown(ConnectionForm)(connectionForm()).pipe(
      Effect.mapError((error) => new ValidationError({ message: String(error) })),
    );
    runEffect(
      Effect.gen(function* () {
        const form = yield* parsed;
        const url = yield* baseUrl(form);
        const authenticated = yield* authenticate(url, form);
        const available = yield* fetchSuggestions(authenticated);
        return { authenticated, available };
      }),
      ({ authenticated, available }) => {
        setConnection(authenticated);
        setSuggestions(available);
        setSecret("");
        setTotp("");
        setScreen("filters");
        setFocus(0);
        setMessage(`Connected · session valid ${authenticated.session.validity}s`);
      },
    );
  };

  const executeQuery = (spec: QuerySpec) => {
    const active = connection();
    if (active === null) return;
    setScreen("results");
    setSelected(0);
    runEffect(fetchAllQueries(active, spec), (result) => {
      setRows(result);
      setActiveSpec(spec);
      setMessage(`${result.length.toLocaleString()} queries`);
    });
  };

  const submitFilters = () =>
    runEffect(
      Schema.decodeUnknown(FilterForm)(filters).pipe(
        Effect.mapError((error) => new ValidationError({ message: String(error) })),
        Effect.flatMap(toQuerySpec),
      ),
      (spec) => {
        if (needsHeavyQueryConfirmation(spec)) {
          setPendingSpec(spec);
          setScreen("confirm");
        } else executeQuery(spec);
      },
    );

  const exportRows = () => {
    const path = exportPath().trim();
    if (path === "") return setMessage("Enter an export destination");
    runEffect(writeCsv(path, rows()), (result) => {
      setScreen("results");
      setMessage(`Exported ${result.count.toLocaleString()} rows → ${result.path}`);
    });
  };

  const quit = () => {
    const active = connection();
    const done = Effect.sync(() => renderer.destroy());
    runtime.runFork(
      active === null
        ? done
        : logout(active).pipe(
            Effect.timeout("1 second"),
            Effect.catchAll(() => Effect.void),
            Effect.andThen(done),
          ),
    );
  };

  const openSuggestions = () => {
    const mapping: Partial<Record<number, SuggestionField>> = {
      3: "domain",
      4: "client_ip",
      5: "client_name",
      6: "upstream",
      7: "type",
      8: "status",
      9: "reply",
      10: "dnssec",
    };
    const field = mapping[focus()];
    if (field === undefined || suggestions()[field].length === 0)
      return setMessage(
        "No suggestions for this field; manual input and * wildcards are supported",
      );
    setSuggestionField(field);
    setSuggestionIndex(0);
    setScreen("suggestions");
  };

  const applySuggestion = () => {
    const field = suggestionField();
    if (field === null) return;
    const value = suggestions()[field][suggestionIndex()];
    if (value === undefined) return;
    switch (field) {
      case "domain":
        setFilters("domain", value);
        break;
      case "client_ip":
        setFilters("clientIp", value);
        break;
      case "client_name":
        setFilters("clientName", value);
        break;
      case "upstream":
        setFilters("upstream", value);
        break;
      case "type":
        setFilters("type", value);
        break;
      case "status":
        setFilters("status", value);
        break;
      case "reply":
        setFilters("reply", value);
        break;
      case "dnssec":
        setFilters("dnssec", value);
        break;
    }
    setScreen("filters");
  };

  const selectAuth = (method: AuthMethod) => {
    if (method === authMethod()) return;
    setAuthMethod(method);
    setSecret("");
    setTotp("");
  };

  const cycleAuth = (delta: number) => {
    const methods: ReadonlyArray<AuthMethod> = ["password", "session", "none"];
    const index = methods.indexOf(authMethod());
    selectAuth(methods[(index + delta + methods.length) % methods.length] ?? "password");
  };

  const connectControls = (): ReadonlyArray<ConnectFocus> =>
    authMethod() === "password"
      ? ["host", "scheme", "port", "auth", "secret", "totp", "connect"]
      : authMethod() === "session"
        ? ["host", "scheme", "port", "auth", "secret", "connect"]
        : ["host", "scheme", "port", "auth", "connect"];

  const moveConnectFocus = (delta: number) => {
    const controls = connectControls();
    const index = Math.max(0, controls.indexOf(connectFocus()));
    setConnectFocus(controls[(index + delta + controls.length) % controls.length] ?? "host");
  };

  const connectionIsFocused = (target: ConnectFocus) =>
    screen() === "connect" && connectFocus() === target;
  const filterIsFocused = (index: number) => screen() === "filters" && focus() === index;

  const moveSelection = (delta: number) => {
    if (rows().length === 0) return;
    setSelected((value) => Math.max(0, Math.min(rows().length - 1, value + delta)));
  };

  useKeyboard((key) => {
    const current = screen();
    if (key.ctrl && key.name === "c") return quit();
    if (current === "connect") {
      if (key.name === "tab") {
        key.preventDefault();
        moveConnectFocus(key.shift ? -1 : 1);
        return;
      }
      if (key.name === "escape") return quit();
      if (
        connectFocus() === "scheme" &&
        (key.name === "left" ||
          key.name === "right" ||
          key.name === "space" ||
          key.name === "return")
      ) {
        key.preventDefault();
        setScheme(scheme() === "http" ? "https" : "http");
        return;
      }
      if (
        connectFocus() === "auth" &&
        (key.name === "left" || key.name === "right" || key.name === "space")
      ) {
        key.preventDefault();
        cycleAuth(key.name === "left" ? -1 : 1);
        return;
      }
      if (connectFocus() === "connect" && key.name === "return") {
        key.preventDefault();
        connect();
      }
      return;
    }
    if (current === "filters") {
      if (key.name === "tab") {
        key.preventDefault();
        setFocus((focus() + (key.shift ? 12 : 1)) % 13);
        return;
      }
      if (key.name === "escape") return quit();
      if (key.ctrl && key.name === "space") {
        key.preventDefault();
        openSuggestions();
        return;
      }
      if (focus() === 11 && (key.name === "space" || key.name === "return")) {
        key.preventDefault();
        setFilters("disk", !filters.disk);
        return;
      }
      if (focus() === 12 && key.name === "return") {
        key.preventDefault();
        submitFilters();
      }
      return;
    }
    if (current === "results") {
      if (busy()) {
        if (key.name === "escape") {
          cancel?.();
          setMessage("Cancelled");
        } else if (key.name === "q") quit();
        return;
      }
      if (key.name === "down" || key.name === "j") moveSelection(1);
      else if (key.name === "up" || key.name === "k") moveSelection(-1);
      else if (key.name === "return" && rows().length > 0) setScreen("inspect");
      else if (key.name === "f") {
        setScreen("filters");
        setFocus(0);
      } else if (key.name === "r") {
        const spec = activeSpec();
        if (spec !== null) executeQuery(spec);
      } else if (key.name === "e") {
        const spec = activeSpec();
        if (spec !== null) {
          setExportPath(defaultFilename(spec));
          setScreen("export");
        }
      } else if (key.name === "?") {
        setReturnScreen("results");
        setScreen("help");
      } else if (key.name === "escape") setScreen("filters");
      else if (key.name === "q") quit();
      return;
    }
    if (current === "suggestions") {
      const field = suggestionField();
      const count = field === null ? 0 : suggestions()[field].length;
      if (key.name === "down" || key.name === "j")
        setSuggestionIndex((suggestionIndex() + 1) % Math.max(1, count));
      else if (key.name === "up" || key.name === "k")
        setSuggestionIndex((suggestionIndex() - 1 + Math.max(1, count)) % Math.max(1, count));
      else if (key.name === "return") applySuggestion();
      else if (key.name === "escape") setScreen("filters");
      return;
    }
    if (current === "confirm") {
      if (key.name === "return") {
        const spec = pendingSpec();
        if (spec !== null) executeQuery(spec);
      } else if (key.name === "escape" || key.name === "n") setScreen("filters");
      return;
    }
    if (current === "export") {
      if (key.name === "escape") setScreen("results");
      return;
    }
    if (key.name === "escape" || key.name === "q" || key.name === "return")
      setScreen(returnScreen());
  });

  const visibleRows = () => {
    const count = Math.max(1, dimensions().height - 5);
    const start = Math.max(0, Math.min(selected() - Math.floor(count / 2), rows().length - count));
    return rows()
      .slice(start, start + count)
      .map((row, offset) => ({ row, index: start + offset }));
  };

  const tableLine = (row: Query) => {
    const width = dimensions().width;
    const time = new Date(row.time * 1000).toLocaleString(undefined, { hour12: false });
    const fixed = width >= 120 ? 91 : width >= 90 ? 69 : 48;
    const domainWidth = Math.max(12, width - fixed);
    const cells = [
      truncate(time, 20),
      truncate(row.domain, domainWidth),
      truncate(row.client.name ?? row.client.ip, 18),
      truncate(row.type, 7),
    ];
    if (width >= 90)
      cells.push(truncate(row.status ?? "—", 12), truncate(row.reply.type ?? "—", 10));
    if (width >= 120) cells.push(truncate(row.upstream ?? "—", 20));
    return cells.join(" ");
  };

  const tableHeader = () => {
    const width = dimensions().width;
    const fixed = width >= 120 ? 91 : width >= 90 ? 69 : 48;
    const cells = [
      truncate("TIMESTAMP", 20),
      truncate("DOMAIN", Math.max(12, width - fixed)),
      truncate("CLIENT", 18),
      truncate("TYPE", 7),
    ];
    if (width >= 90) cells.push(truncate("STATUS", 12), truncate("REPLY", 10));
    if (width >= 120) cells.push(truncate("UPSTREAM", 20));
    return cells.join(" ");
  };

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.bg}>
      <box height={1} backgroundColor={theme.bgHighlight} paddingLeft={1}>
        <text fg={theme.purple}>
          <b>PI-HOLE EXPORT</b> · v6 HTTP API
        </text>
      </box>
      <box flexGrow={1} flexDirection="column">
        <Switch>
          <Match when={screen() === "connect"}>
            <box flexDirection="column" width="100%" maxWidth={100} padding={1} gap={1}>
              <box
                height={1}
                width="100%"
                flexDirection="row"
                backgroundColor={theme.bgHighlight}
                paddingLeft={1}
                paddingRight={1}
                justifyContent="space-between">
                <text fg={theme.purple}>
                  <b>CONNECTION</b>
                </text>
                <text fg={theme.muted}>AUTHENTICATE TO CONTINUE</text>
              </box>
              <box flexDirection="row" gap={1}>
                <box flexDirection="column" height={2} width={12} minWidth={12}>
                  <text fg={connectFocus() === "scheme" ? theme.cyan : theme.fg}>Scheme</text>
                  <box
                    height={1}
                    backgroundColor={fieldBg(connectFocus() === "scheme")}
                    paddingLeft={1}>
                    <text fg={connectFocus() === "scheme" ? theme.yellow : theme.fg}>
                      {scheme()} ◀▶
                    </text>
                  </box>
                </box>
                <Field
                  label="Pi-hole IP / domain / full URL"
                  value={host()}
                  focused={connectionIsFocused("host")}
                  placeholder="10.200.0.242 or https://pi.hole"
                  onInput={setHost}
                  onSubmit={connect}
                />
                <Field
                  label="Port (optional)"
                  value={port()}
                  focused={connectionIsFocused("port")}
                  placeholder="80 / 443"
                  width={14}
                  minWidth={14}
                  flexGrow={0}
                  onInput={setPort}
                  onSubmit={connect}
                />
              </box>
              <box flexDirection="column" height={2}>
                <text fg={connectFocus() === "auth" ? theme.cyan : theme.fg}>Authentication</text>
                <box flexDirection="row" height={1}>
                  <For each={["password", "session", "none"] as const}>
                    {(method) => (
                      <box
                        width={method === "session" ? 15 : 12}
                        paddingLeft={1}
                        backgroundColor={authMethod() === method ? theme.blueDark : theme.bgStripe}
                        onMouseDown={() => {
                          selectAuth(method);
                          setConnectFocus("auth");
                        }}>
                        <text fg={authMethod() === method ? theme.green : theme.muted}>
                          {method === "session" ? "SESSION ID" : method.toUpperCase()}
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              </box>
              <Show when={authMethod() !== "none"} fallback={<box />}>
                <box flexDirection="row" gap={1}>
                  <Field
                    label={
                      authMethod() === "session"
                        ? "Existing session ID"
                        : "Admin / application password"
                    }
                    value={secret()}
                    focused={connectionIsFocused("secret")}
                    secret
                    placeholder={authMethod() === "session" ? "Session credential" : "Password"}
                    onInput={setSecret}
                    onSubmit={connect}
                  />
                  <Show when={authMethod() === "password"} fallback={<box />}>
                    <Field
                      label="TOTP (optional)"
                      value={totp()}
                      focused={connectionIsFocused("totp")}
                      secret
                      placeholder="123456"
                      width={20}
                      minWidth={20}
                      flexGrow={0}
                      onInput={setTotp}
                      onSubmit={connect}
                    />
                  </Show>
                </box>
              </Show>
              <box flexDirection="row" alignItems="center" gap={2}>
                <ActionButton
                  label={busy() ? "CONNECTING…" : "CONNECT"}
                  focused={connectFocus() === "connect"}
                  onPress={connect}
                />
                <text fg={theme.muted}>
                  Credentials remain in memory only · TLS recommended off-host
                </text>
              </box>
            </box>
          </Match>

          <Match when={screen() === "filters"}>
            <box flexDirection="column" padding={1} gap={1}>
              <text fg={theme.cyan}>ADVANCED FILTERING</text>
              <box gap={1}>
                <Field
                  label="From · local (inclusive)"
                  value={filters.from}
                  focused={filterIsFocused(0)}
                  onInput={(v) => setFilters("from", v)}
                />
                <Field
                  label="Until · local (exclusive)"
                  value={filters.until}
                  focused={filterIsFocused(1)}
                  onInput={(v) => setFilters("until", v)}
                />
                <Field
                  label="Timezone (IANA)"
                  value={filters.timezone}
                  focused={filterIsFocused(2)}
                  placeholder="America/Sao_Paulo"
                  onInput={(v) => setFilters("timezone", v)}
                />
                <box
                  alignItems="center"
                  gap={1}
                  height={2}
                  onMouseDown={() => setFilters("disk", !filters.disk)}>
                  <text fg={filters.disk ? theme.yellow : theme.muted}>
                    {filters.disk ? "[x]" : "[ ]"}
                  </text>
                  <text fg={focus() === 11 ? theme.cyan : theme.fg}>
                    On-disk · slower
                    {dimensions().width > 100 ? "; needed beyond in-memory history" : ""}
                  </text>
                </box>
              </box>
              <box gap={1}>
                <Field
                  label="Domain*"
                  value={filters.domain}
                  focused={filterIsFocused(3)}
                  placeholder="Select or type…"
                  onInput={(v) => setFilters("domain", v)}
                />
                <Field
                  label="Client (IP)*"
                  value={filters.clientIp}
                  focused={filterIsFocused(4)}
                  placeholder="Select or type…"
                  onInput={(v) => setFilters("clientIp", v)}
                />
                <Field
                  label="Client (name)*"
                  value={filters.clientName}
                  focused={filterIsFocused(5)}
                  placeholder="Select or type…"
                  onInput={(v) => setFilters("clientName", v)}
                />
                <Field
                  label="Upstream*"
                  value={filters.upstream}
                  focused={filterIsFocused(6)}
                  placeholder="Select or type…"
                  onInput={(v) => setFilters("upstream", v)}
                />
              </box>
              <box gap={1}>
                <Field
                  label="Type"
                  value={filters.type}
                  focused={filterIsFocused(7)}
                  placeholder="Select or type…"
                  onInput={(v) => setFilters("type", v)}
                />
                <Field
                  label="Status"
                  value={filters.status}
                  focused={filterIsFocused(8)}
                  placeholder="Select or type…"
                  onInput={(v) => setFilters("status", v)}
                />
                <Field
                  label="Reply"
                  value={filters.reply}
                  focused={filterIsFocused(9)}
                  placeholder="Select or type…"
                  onInput={(v) => setFilters("reply", v)}
                />
                <Field
                  label="DNSSEC status"
                  value={filters.dnssec}
                  focused={filterIsFocused(10)}
                  placeholder="Select or type…"
                  onInput={(v) => setFilters("dnssec", v)}
                />
              </box>
              <text fg={theme.muted}>
                * Manual input supported · * wildcard · Ctrl+Space opens Pi-hole suggestions
              </text>
              <box>
                <ActionButton
                  label={busy() ? "QUERYING…" : "FETCH QUERIES"}
                  focused={focus() === 12}
                  onPress={submitFilters}
                />
              </box>
            </box>
          </Match>

          <Match when={screen() === "results"}>
            <box height={1} paddingLeft={1}>
              <text fg={theme.green}>
                {busy()
                  ? "FETCHING ALL PAGES… Esc cancels"
                  : `${rows().length.toLocaleString()} QUERIES`}
              </text>
            </box>
            <box height={1} paddingLeft={1} backgroundColor={theme.bgHighlight}>
              <text fg={theme.green}>{tableHeader()}</text>
            </box>
            <box flexDirection="column" flexGrow={1}>
              <For each={visibleRows()}>
                {({ row, index }) => (
                  <box
                    height={1}
                    paddingLeft={1}
                    backgroundColor={
                      index === selected()
                        ? theme.blueDark
                        : index % 2 === 0
                          ? theme.bg
                          : theme.bgStripe
                    }>
                    <text fg={index === selected() ? theme.fg : theme.fg}>
                      {index === selected() ? "> " : "  "}
                      {tableLine(row)}
                    </text>
                  </box>
                )}
              </For>
              <Show when={!busy() && rows().length === 0} fallback={<box />}>
                <text fg={theme.muted}> No matching queries.</text>
              </Show>
            </box>
          </Match>
        </Switch>
      </box>

      <Show
        when={screen() === "connect"}
        fallback={
          <Show when={message() !== ""} fallback={<box />}>
            <box height={1} paddingLeft={1}>
              <text
                fg={
                  message().startsWith("Exported") ||
                  message().startsWith("Connected") ||
                  message().includes("queries")
                    ? theme.green
                    : theme.orange
                }>
                {message()}
              </text>
            </box>
          </Show>
        }>
        <box height={1} width="100%" backgroundColor={theme.bgStripe} paddingLeft={1}>
          <text fg={busy() ? theme.yellow : message() === "" ? theme.green : theme.orange}>
            {busy() ? "CONNECTING · AUTHENTICATING AND VERIFYING PI-HOLE V6" : message() || "READY"}
          </text>
        </box>
      </Show>

      <Show when={screen() === "connect"} fallback={<box />}>
        <KeyBar
          items={[
            ["TAB", "NEXT"],
            ["S-TAB", "PREV"],
            ["◀/▶", "SELECT"],
            ["ENTER", "CONNECT"],
            ["ESC", "QUIT"],
          ]}
        />
      </Show>
      <Show when={screen() === "filters"} fallback={<box />}>
        <KeyBar
          items={[
            ["TAB", "NEXT"],
            ["^SPACE", "SUGGEST"],
            ["ENTER", "QUERY"],
            ["ESC", "QUIT"],
          ]}
        />
      </Show>
      <Show when={screen() === "results"} fallback={<box />}>
        <KeyBar
          items={[
            ["↑/↓ J/K", "NAVIGATE"],
            ["ENTER", "INSPECT"],
            ["F", "FILTERS"],
            ["R", "RERUN"],
            ["E", "EXPORT"],
            ["?", "HELP"],
            ["Q", "QUIT"],
          ]}
        />
      </Show>

      <Show when={screen() === "confirm"} fallback={<box />}>
        {(_) => (
          <box
            position="absolute"
            top={0}
            left={0}
            zIndex={1000}
            width="100%"
            height="100%"
            alignItems="center"
            justifyContent="center"
            backgroundColor={theme.bgDark}>
            <box
              width="80%"
              maxWidth={82}
              flexDirection="column"
              backgroundColor={theme.bgHighlight}
              border
              borderColor={theme.yellow}
              padding={1}
              gap={1}>
              <text fg={theme.yellow}>HEAVY QUERY</text>
              <text fg={theme.fg}>
                This query scans more than 2 days of history without any additional filter and may
                cause heavy disk I/O. Continue?
              </text>
              <text fg={theme.muted}>Enter continue · Esc/N cancel</text>
            </box>
          </box>
        )}
      </Show>

      <Show when={screen() === "suggestions"} fallback={<box />}>
        {(_) => (
          <box
            position="absolute"
            top={0}
            left={0}
            zIndex={1000}
            width="100%"
            height="100%"
            alignItems="center"
            justifyContent="center"
            backgroundColor={theme.bgDark}>
            <box
              width="70%"
              maxWidth={72}
              maxHeight="70%"
              flexDirection="column"
              backgroundColor={theme.bgHighlight}
              border
              borderColor={theme.blue}
              padding={1}>
              <text fg={theme.cyan}>PI-HOLE SUGGESTIONS · {suggestionField() ?? ""}</text>
              <For
                each={(() => {
                  const field = suggestionField();
                  return field === null ? [] : suggestions()[field];
                })()}>
                {(item, index) => (
                  <box
                    backgroundColor={
                      index() === suggestionIndex() ? theme.blueDark : "transparent"
                    }>
                    <text fg={theme.fg}>
                      {index() === suggestionIndex() ? "> " : "  "}
                      {item}
                    </text>
                  </box>
                )}
              </For>
              <text fg={theme.muted}>↑/↓ or j/k select · Enter apply · Esc keep manual input</text>
            </box>
          </box>
        )}
      </Show>

      <Show when={screen() === "inspect"} fallback={<box />}>
        {(_) => (
          <box
            position="absolute"
            top={0}
            left={0}
            zIndex={1000}
            width="100%"
            height="100%"
            alignItems="center"
            justifyContent="center"
            backgroundColor={theme.bgDark}>
            <box
              width="85%"
              maxWidth={100}
              flexDirection="column"
              backgroundColor={theme.bgHighlight}
              border
              borderColor={theme.blue}
              padding={1}>
              <text fg={theme.cyan}>QUERY {rows()[selected()]?.id ?? ""}</text>
              <Show when={rows()[selected()]} fallback={<box />}>
                {(item) => (
                  <box flexDirection="column">
                    <text>Time {new Date(item().time * 1000).toISOString()}</text>
                    <text>Domain {item().domain}</text>
                    <text>
                      Client {item().client.ip} {item().client.name ?? ""}
                    </text>
                    <text>Type {item().type}</text>
                    <text>Status {item().status ?? "—"}</text>
                    <text>
                      Reply {item().reply.type ?? "—"} · {item().reply.time} ms
                    </text>
                    <text>Upstream {item().upstream ?? "—"}</text>
                    <text>DNSSEC {item().dnssec ?? "—"}</text>
                    <text>CNAME {item().cname ?? "—"}</text>
                    <text>
                      EDE {item().ede.code} {item().ede.text ?? ""}
                    </text>
                  </box>
                )}
              </Show>
              <text fg={theme.muted}>Esc / Enter close</text>
            </box>
          </box>
        )}
      </Show>

      <Show when={screen() === "export"} fallback={<box />}>
        {(_) => (
          <box
            position="absolute"
            top={0}
            left={0}
            zIndex={1000}
            width="100%"
            height="100%"
            alignItems="center"
            justifyContent="center"
            backgroundColor={theme.bgDark}>
            <box
              width="85%"
              maxWidth={100}
              flexDirection="column"
              backgroundColor={theme.bgHighlight}
              border
              borderColor={theme.green}
              padding={1}
              gap={1}>
              <text fg={theme.green}>
                EXPORT ALL {rows().length.toLocaleString()} MATCHING ROWS
              </text>
              <Field
                label="Local or UNC destination"
                value={exportPath()}
                focused={screen() === "export"}
                placeholder="queries.csv or \\server\share\queries.csv"
                onInput={setExportPath}
                onSubmit={exportRows}
              />
              <text fg={theme.muted}>Enter export · Esc cancel</text>
            </box>
          </box>
        )}
      </Show>

      <Show when={screen() === "help"} fallback={<box />}>
        {(_) => (
          <box
            position="absolute"
            top={0}
            left={0}
            zIndex={1000}
            width="100%"
            height="100%"
            alignItems="center"
            justifyContent="center"
            backgroundColor={theme.bgDark}>
            <box
              width="70%"
              maxWidth={76}
              flexDirection="column"
              backgroundColor={theme.bgHighlight}
              border
              borderColor={theme.purple}
              padding={1}>
              <text fg={theme.purple}>HELP</text>
              <text>
                ↑/↓, j/k navigate · Enter inspect · f filters · r rerun · e export all · ? help · q
                quit
              </text>
              <text>Tab / Shift+Tab moves forms · Esc backs out or cancels active work.</text>
              <text fg={theme.muted}>
                Normal typing is never intercepted while an input is focused.
              </text>
            </box>
          </box>
        )}
      </Show>
    </box>
  );
}
