/** @jsxImportSource @opentui/solid */
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { Effect, Fiber, Schema } from "effect";
import { createMemo, createSignal, Match, Show, Switch } from "solid-js";
import { createStore } from "solid-js/store";

import { analyzeQueries, isBlockedQuery } from "./lib/analytics";
import {
  authenticate,
  type AuthenticatedConnection,
  type DomainMutationAction,
  fetchAllQueries,
  fetchSuggestions,
  logout,
  mutateDomain,
} from "./lib/api";
import { exportNative } from "./lib/backend";
import {
  dispatchFilterRequest,
  prepareFilterRequest,
  type FilterAction,
  type FilterRequest,
} from "./lib/filter-action";
import {
  type AuthMethod,
  ConnectionForm,
  type ExportFormat,
  FilterForm,
  type Query,
  type QueryPreset,
  type Suggestions,
  ValidationError,
} from "./lib/model";
import {
  defaultPresetPath,
  loadPresets,
  removePreset,
  savePresets,
  upsertPreset,
} from "./lib/presets";
import {
  baseUrl,
  defaultFilename,
  type QuerySpec,
  refineFiltersFromQuery,
  type RefinableField,
  type ResultSort,
  searchAndSortQueries,
} from "./lib/query";
import { runtime, type AppServices } from "./lib/runtime";
import { defaultRange } from "./lib/time";
import {
  ConfirmDialog,
  DomainActionDialog,
  ExportDialog,
  HelpDialog,
  InspectDialog,
  PresetDialog,
  SearchDialog,
  SuggestionDialog,
} from "./ui/dialogs";
import {
  connectControls,
  type ConnectFocus,
  filterControlCount,
  moveCyclic,
  moveIndex,
  resultActions,
  type Screen,
} from "./ui/focus";
import { useWorkbenchKeyboard } from "./ui/keyboard";
import { KeyBar } from "./ui/primitives";
import { ConnectionScreen } from "./ui/screens/ConnectionScreen";
import { FilterScreen } from "./ui/screens/FilterScreen";
import { ResultsScreen } from "./ui/screens/ResultsScreen";
import { theme } from "./ui/theme";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type SuggestionField = keyof Suggestions;

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

const sortOrder: ReadonlyArray<ResultSort> = [
  "time-desc",
  "time-asc",
  "domain",
  "client",
  "status",
];

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
  const [returnScreen, setReturnScreen] = createSignal<Screen>("results");
  const [connectFocus, setConnectFocus] = createSignal<ConnectFocus>("host");
  const [filterFocus, setFilterFocus] = createSignal(0);
  const [resultFocus, setResultFocus] = createSignal(0);
  const [resultControlMode, setResultControlMode] = createSignal(false);
  const [dialogFocus, setDialogFocus] = createSignal(0);
  const [connection, setConnection] = createSignal<AuthenticatedConnection | null>(null);
  const [suggestions, setSuggestions] = createSignal<Suggestions>(emptySuggestions);
  const [suggestionField, setSuggestionField] = createSignal<SuggestionField | null>(null);
  const [suggestionIndex, setSuggestionIndex] = createSignal(0);
  const [rows, setRows] = createSignal<ReadonlyArray<Query>>([]);
  const [selected, setSelected] = createSignal(0);
  const [inspectTarget, setInspectTarget] = createSignal<Query | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [exportSpec, setExportSpec] = createSignal<QuerySpec | null>(null);
  const [exportReturnScreen, setExportReturnScreen] = createSignal<"filters" | "results">(
    "filters",
  );
  const [pendingRequest, setPendingRequest] = createSignal<FilterRequest | null>(null);
  const [pendingDomainAction, setPendingDomainAction] = createSignal<{
    readonly domain: string;
    readonly action: DomainMutationAction;
  } | null>(null);
  const [activeSpec, setActiveSpec] = createSignal<QuerySpec | null>(null);
  const [aggregate, setAggregate] = createSignal(false);
  const [sort, setSort] = createSignal<ResultSort>("time-desc");
  const [search, setSearch] = createSignal("");
  const [searchDraft, setSearchDraft] = createSignal("");
  const [exportPath, setExportPath] = createSignal("");
  const [exportFormat, setExportFormat] = createSignal<ExportFormat>("csv");
  const [presets, setPresets] = createSignal<ReadonlyArray<QueryPreset>>([]);
  const [presetName, setPresetName] = createSignal("");
  let cancel: (() => void) | undefined;
  let runId = 0;

  const visibleRows = createMemo(() => searchAndSortQueries(rows(), search(), sort()));
  const analytics = createMemo(() => analyzeQueries(visibleRows()));
  const selectedRow = () => visibleRows()[selected()];

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
        Effect.catch((error) =>
          Effect.sync(() => setMessage(error instanceof Error ? error.message : String(error))),
        ),
        Effect.ensuring(Effect.sync(() => id === runId && setBusy(false))),
      ),
    );
    cancel = () => Effect.runFork(Fiber.interrupt(fiber));
  };

  const connectionForm = (): Mutable<ConnectionForm> => ({
    host: host(),
    scheme: scheme(),
    port: port(),
    authMethod: authMethod(),
    secret: secret(),
    totp: totp(),
  });

  const connect = () => {
    const parsed = Schema.decodeUnknownEffect(ConnectionForm)(connectionForm()).pipe(
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
        setFilterFocus(0);
        setMessage(`Connected · session valid ${authenticated.session.validity}s`);
      },
    );
  };

  const executeQuery = (spec: QuerySpec) => {
    const active = connection();
    if (active === null) return;
    setScreen("results");
    setSelected(0);
    setActiveSpec(spec);
    runEffect(fetchAllQueries(active, spec), (result) => {
      setRows(result);
      setMessage(`${result.length.toLocaleString()} queries`);
    });
  };

  const filterHandlers = {
    confirm: (request: FilterRequest) => {
      setPendingRequest(request);
      setDialogFocus(0);
      setScreen("confirm");
    },
    query: executeQuery,
    export: (spec: QuerySpec) => openExportForSpec(spec, "filters"),
  };

  const submitFilters = (action: FilterAction = "query") =>
    runEffect(prepareFilterRequest(filters, action), (request) =>
      dispatchFilterRequest(request, filterHandlers),
    );

  const stopWork = (text = "Cancelled") => {
    cancel?.();
    runId += 1;
    setBusy(false);
    setMessage(text);
  };

  const openExportForSpec = (spec: QuerySpec, origin: "filters" | "results") => {
    setExportSpec(spec);
    setExportReturnScreen(origin);
    setExportPath(defaultFilename(spec, exportFormat()));
    setDialogFocus(1);
    setScreen("export");
  };

  const acceptPending = () => {
    const request = pendingRequest();
    setPendingRequest(null);
    if (request !== null) dispatchFilterRequest(request, filterHandlers, true);
  };

  const openExport = () => {
    const spec = activeSpec();
    if (spec !== null) openExportForSpec(spec, "results");
  };

  const changeExportFormat = (format: ExportFormat) => {
    const spec = exportSpec();
    if (spec !== null && exportPath() === defaultFilename(spec, exportFormat()))
      setExportPath(defaultFilename(spec, format));
    setExportFormat(format);
  };

  const cancelExport = () => {
    if (busy()) stopWork("Export cancelled");
    setScreen(exportReturnScreen());
  };

  const exportRows = () => {
    if (busy()) return;
    const active = connection();
    const spec = exportSpec();
    const path = exportPath().trim();
    if (active === null || spec === null) return;
    if (path === "") return setMessage("Enter an export destination");
    runEffect(exportNative(active, spec, path, exportFormat()), (result) => {
      setScreen(exportReturnScreen());
      setMessage(`Exported ${result.count.toLocaleString()} rows → ${result.path}`);
    });
  };

  const openPresets = () => {
    runEffect(loadPresets(defaultPresetPath()), (loaded) => {
      setPresets(loaded);
      setPresetName("");
      setDialogFocus(0);
      setScreen("presets");
    });
  };

  const saveCurrentPreset = () => {
    if (presetName().trim() === "") return setMessage("Enter a preset name");
    const next = upsertPreset(presets(), presetName(), filters);
    runEffect(savePresets(defaultPresetPath(), next), (saved) => {
      setPresets(saved);
      setMessage(`Saved preset “${presetName().trim()}”`);
      setPresetName("");
      setDialogFocus(0);
    });
  };

  const deletePreset = (index: number) => {
    const preset = presets()[index];
    if (preset === undefined) return;
    const next = removePreset(presets(), preset.name);
    runEffect(savePresets(defaultPresetPath(), next), (saved) => {
      setPresets(saved);
      setDialogFocus(Math.min(dialogFocus(), Math.max(0, 2 + saved.length * 2)));
      setMessage(`Deleted preset “${preset.name}”`);
    });
  };

  const applyPreset = (index: number) => {
    const preset = presets()[index];
    if (preset === undefined) return;
    setFilters({ ...preset.filters });
    setScreen("filters");
    setFilterFocus(0);
    setMessage(`Loaded preset “${preset.name}”`);
  };

  const refine = (field: RefinableField) => {
    const row = screen() === "inspect" ? inspectTarget() : selectedRow();
    if (row === undefined || row === null) return;
    setFilters({ ...refineFiltersFromQuery(filters, row, field) });
    setScreen("filters");
    setFilterFocus(
      field === "domain"
        ? 3
        : field === "clientIp"
          ? 4
          : field === "clientName"
            ? 5
            : field === "upstream"
              ? 6
              : field === "type"
                ? 7
                : 8,
    );
    setMessage(`Filter refined from selected ${field}`);
  };

  const quit = () => {
    cancel?.();
    const active = connection();
    const done = Effect.sync(() => renderer.destroy());
    runtime.runFork(
      active === null
        ? done
        : logout(active).pipe(
            Effect.timeout("1 second"),
            Effect.catch(() => Effect.void),
            Effect.andThen(done),
          ),
    );
  };

  const selectAuth = (method: AuthMethod) => {
    setAuthMethod(method);
    setSecret("");
    setTotp("");
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
    const field = mapping[filterFocus()];
    if (field === undefined || suggestions()[field].length === 0)
      return setMessage(
        "No suggestions for this field; manual input and * wildcards are supported",
      );
    setSuggestionField(field);
    setSuggestionIndex(0);
    setDialogFocus(0);
    setScreen("suggestions");
  };

  const applySuggestion = () => {
    const field = suggestionField();
    const value = field === null ? undefined : suggestions()[field][suggestionIndex()];
    if (field === null || value === undefined) return;
    const keys: Record<SuggestionField, keyof Mutable<FilterForm>> = {
      domain: "domain",
      client_ip: "clientIp",
      client_name: "clientName",
      upstream: "upstream",
      type: "type",
      status: "status",
      reply: "reply",
      dnssec: "dnssec",
    };
    setFilters(keys[field], value);
    setScreen("filters");
  };

  const moveSelection = (delta: number) => {
    setResultControlMode(false);
    setSelected((value) => moveIndex(value, delta, visibleRows().length, false));
  };

  const inspect = () => {
    const row = selectedRow();
    if (row === undefined) return;
    setInspectTarget(row);
    setDialogFocus(0);
    setScreen("inspect");
  };

  const openDomainAction = () => {
    const row = selectedRow();
    if (row === undefined) return setMessage("Select a query first");
    setPendingDomainAction({
      domain: row.domain,
      action: isBlockedQuery(row) ? "unblock" : "block",
    });
    setDialogFocus(0);
    setScreen("domain-confirm");
  };

  const confirmDomainAction = () => {
    const active = connection();
    const pending = pendingDomainAction();
    if (active === null || pending === null) return;
    setScreen("results");
    runEffect(mutateDomain(active, pending.domain, pending.action), () => {
      setPendingDomainAction(null);
      setMessage(`${pending.action === "block" ? "Blocked" : "Unblocked"} ${pending.domain}`);
    });
  };

  const cycleSort = () => setSort((current) => moveCyclic(sortOrder, current, 1));

  const runResultAction = (index: number) => {
    switch (resultActions[index]) {
      case "SEARCH":
        setSearchDraft(search());
        setDialogFocus(0);
        setScreen("search");
        break;
      case "SORT":
        cycleSort();
        setSelected(0);
        break;
      case "AGGREGATE":
        setAggregate((value) => !value);
        break;
      case "REFINE":
        inspect();
        break;
      case "BLOCK":
        openDomainAction();
        break;
      case "EXPORT":
        openExport();
        break;
      case "PRESETS":
        setReturnScreen("results");
        openPresets();
        break;
      case "FILTERS":
        setScreen("filters");
        setFilterFocus(0);
        break;
      case "HELP":
        setReturnScreen("results");
        setScreen("help");
        break;
    }
  };

  useWorkbenchKeyboard({
    screen,
    busy,
    quit,
    connectFocus,
    moveConnectFocus: (delta) =>
      setConnectFocus(moveCyclic(connectControls(authMethod()), connectFocus(), delta)),
    toggleScheme: () => setScheme(scheme() === "http" ? "https" : "http"),
    cycleAuth: (delta) => {
      const methods: ReadonlyArray<AuthMethod> = ["password", "session", "none"];
      selectAuth(moveCyclic(methods, authMethod(), delta));
    },
    connect,
    filterFocus,
    moveFilterFocus: (delta) => setFilterFocus(moveIndex(filterFocus(), delta, filterControlCount)),
    toggleDisk: () => setFilters("disk", !filters.disk),
    openSuggestions,
    openPresets,
    submitFilters,
    exportFilters: () => submitFilters("export"),
    stopWork,
    moveResultFocus: (delta) => {
      setResultControlMode(true);
      setResultFocus(moveIndex(resultFocus(), delta, resultActions.length));
    },
    moveSelection,
    activateResult: () => (resultControlMode() ? runResultAction(resultFocus()) : inspect()),
    resultAction: runResultAction,
    rerun: () => {
      const spec = activeSpec();
      if (spec !== null) executeQuery(spec);
    },
    moveDialogFocus: (delta, count) => setDialogFocus(moveIndex(dialogFocus(), delta, count)),
    moveSuggestion: (delta) => {
      setDialogFocus(0);
      const field = suggestionField();
      const count = field === null ? 0 : suggestions()[field].length;
      setSuggestionIndex(moveIndex(suggestionIndex(), delta, count));
    },
    applySuggestion: () => (dialogFocus() === 2 ? setScreen("filters") : applySuggestion()),
    showFilters: () => setScreen("filters"),
    acceptConfirm: () => {
      if (dialogFocus() !== 0) return setScreen("filters");
      acceptPending();
    },
    acceptDomainMutation: () => {
      if (dialogFocus() === 0) confirmDomainAction();
      else {
        setPendingDomainAction(null);
        setScreen("results");
      }
    },
    cancelDomainMutation: () => {
      setPendingDomainAction(null);
      setScreen("results");
    },
    showResults: () => setScreen("results"),
    activateInspect: () =>
      dialogFocus() === 0
        ? setScreen("results")
        : refine(refineActionsForKeyboard[dialogFocus() - 1] ?? "domain"),
    activateSearch: () => {
      if (dialogFocus() === 2) {
        setSearch("");
        setSearchDraft("");
      } else if (dialogFocus() === 3) setScreen("results");
      else {
        setSearch(searchDraft());
        setSelected(0);
        setScreen("results");
      }
    },
    cycleExportFormat: (delta) => {
      if (dialogFocus() !== 0) return;
      const formats: ReadonlyArray<ExportFormat> = ["csv", "jsonl", "sqlite", "parquet"];
      changeExportFormat(moveCyclic(formats, exportFormat(), delta));
    },
    exportRows: () => {
      if (dialogFocus() === 3) cancelExport();
      else if (dialogFocus() !== 0) exportRows();
    },
    cancelExport,
    presetControlCount: () => 3 + presets().length * 2,
    activatePreset: () => {
      if (dialogFocus() === 2) return setScreen(returnScreen());
      if (dialogFocus() <= 1) return saveCurrentPreset();
      const item = Math.floor((dialogFocus() - 3) / 2);
      if ((dialogFocus() - 3) % 2 === 0) applyPreset(item);
      else deletePreset(item);
    },
    closePreset: () => setScreen(returnScreen()),
    closeOverlay: () => setScreen(returnScreen()),
  });

  const currentSuggestionItems = () => {
    const field = suggestionField();
    return field === null ? [] : suggestions()[field];
  };

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.bg}>
      <box height={1} backgroundColor={theme.bgHighlight} paddingLeft={1}>
        <text fg={theme.purple}>
          <b>PI-HOLE EXPORT</b> · QUERY WORKBENCH
        </text>
      </box>
      <box flexGrow={1} flexDirection="column">
        <Switch>
          <Match when={screen() === "connect"}>
            <ConnectionScreen
              width={dimensions().width}
              host={host()}
              scheme={scheme()}
              port={port()}
              authMethod={authMethod()}
              secret={secret()}
              totp={totp()}
              focus={connectFocus()}
              busy={busy()}
              onFocus={setConnectFocus}
              onHost={setHost}
              onScheme={setScheme}
              onPort={setPort}
              onAuth={selectAuth}
              onSecret={setSecret}
              onTotp={setTotp}
              onConnect={connect}
            />
          </Match>
          <Match when={screen() === "filters"}>
            <FilterScreen
              width={dimensions().width}
              filters={filters}
              setFilters={setFilters}
              focus={filterFocus()}
              busy={busy()}
              onFocus={setFilterFocus}
              onPresets={() => {
                setReturnScreen("filters");
                openPresets();
              }}
              onSubmit={() => submitFilters()}
              onExport={() => submitFilters("export")}
            />
          </Match>
          <Match when={screen() === "results"}>
            <ResultsScreen
              width={dimensions().width}
              height={dimensions().height}
              rows={visibleRows()}
              selected={selected()}
              busy={busy()}
              aggregate={aggregate()}
              analytics={analytics()}
              search={search()}
              sort={sort()}
              actionFocus={resultFocus()}
              onActionFocus={(index) => {
                setResultFocus(index);
                setResultControlMode(true);
              }}
              onAction={runResultAction}
              onSelect={(index) => {
                setSelected(index);
                setResultControlMode(false);
              }}
              onInspect={inspect}
              onMove={moveSelection}
            />
          </Match>
        </Switch>
      </box>
      <Show when={message() !== "" || screen() === "connect"} fallback={<box />}>
        <box height={1} paddingLeft={1} backgroundColor={theme.bgStripe}>
          <text
            fg={
              busy()
                ? theme.yellow
                : message().startsWith("Exported") ||
                    message().startsWith("Blocked") ||
                    message().startsWith("Unblocked") ||
                    message().startsWith("Connected") ||
                    message().includes("queries")
                  ? theme.green
                  : message() === ""
                    ? theme.green
                    : theme.orange
            }>
            {busy() ? "WORKING… ESC CANCELS" : message() || "READY"}
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
            ["ENTER", "ACTIVATE"],
            ["ESC", "QUIT"],
          ]}
        />
      </Show>
      <Show when={screen() === "results"} fallback={<box />}>
        <KeyBar
          items={[
            ["↑/↓ J/K", "ROWS"],
            ["TAB", "ACTIONS"],
            ["ENTER", "OPEN"],
            ["/", "SEARCH"],
            ["^B", "BLOCK/UNBLOCK"],
            ["E", "EXPORT"],
            ["?", "HELP"],
          ]}
        />
      </Show>

      <Show when={screen() === "confirm"} fallback={<box />}>
        <ConfirmDialog
          focus={dialogFocus()}
          onFocus={setDialogFocus}
          onAccept={acceptPending}
          onCancel={() => setScreen("filters")}
        />
      </Show>
      <Show when={screen() === "domain-confirm" ? pendingDomainAction() : null} fallback={<box />}>
        {(pending) => (
          <DomainActionDialog
            domain={pending().domain}
            action={pending().action}
            focus={dialogFocus()}
            onFocus={setDialogFocus}
            onConfirm={confirmDomainAction}
            onCancel={() => {
              setPendingDomainAction(null);
              setScreen("results");
            }}
          />
        )}
      </Show>
      <Show when={screen() === "suggestions"} fallback={<box />}>
        <SuggestionDialog
          title={suggestionField() ?? ""}
          items={currentSuggestionItems()}
          selected={suggestionIndex()}
          focus={dialogFocus()}
          onFocus={setDialogFocus}
          onSelect={setSuggestionIndex}
          onApply={applySuggestion}
          onMove={(delta) =>
            setSuggestionIndex(moveIndex(suggestionIndex(), delta, currentSuggestionItems().length))
          }
          onCancel={() => setScreen("filters")}
        />
      </Show>
      <Show when={screen() === "inspect" ? inspectTarget() : null} fallback={<box />}>
        {(row) => (
          <InspectDialog
            row={row()}
            focus={dialogFocus()}
            onFocus={setDialogFocus}
            onRefine={refine}
            onClose={() => setScreen("results")}
          />
        )}
      </Show>
      <Show when={screen() === "search"} fallback={<box />}>
        <SearchDialog
          value={searchDraft()}
          focus={dialogFocus()}
          onFocus={setDialogFocus}
          onInput={setSearchDraft}
          onApply={() => {
            setSearch(searchDraft());
            setSelected(0);
            setScreen("results");
          }}
          onClear={() => {
            setSearch("");
            setSearchDraft("");
            setSelected(0);
            setScreen("results");
          }}
          onCancel={() => setScreen("results")}
        />
      </Show>
      <Show when={screen() === "export"} fallback={<box />}>
        <ExportDialog
          path={exportPath()}
          format={exportFormat()}
          focus={dialogFocus()}
          busy={busy()}
          onFocus={setDialogFocus}
          onPath={setExportPath}
          onFormat={changeExportFormat}
          onExport={exportRows}
          onCancel={cancelExport}
        />
      </Show>
      <Show when={screen() === "presets"} fallback={<box />}>
        <PresetDialog
          presets={presets()}
          name={presetName()}
          focus={dialogFocus()}
          onFocus={setDialogFocus}
          onName={setPresetName}
          onSave={saveCurrentPreset}
          onApply={applyPreset}
          onDelete={deletePreset}
          onCancel={() => setScreen(returnScreen() === "results" ? "results" : "filters")}
        />
      </Show>
      <Show when={screen() === "help"} fallback={<box />}>
        <HelpDialog onClose={() => setScreen(returnScreen())} />
      </Show>
    </box>
  );
}

const refineActionsForKeyboard: ReadonlyArray<RefinableField> = [
  "domain",
  "clientIp",
  "clientName",
  "upstream",
  "type",
  "status",
];
