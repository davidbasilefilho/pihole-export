import { FileSystem } from "@effect/platform";
import { Effect, Schema } from "effect";

import { FilterForm, PresetError, PresetFile, QueryPreset } from "./model";

const emptyFile: PresetFile = { version: 1, presets: [] };

export const loadPresets = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(path)
      .pipe(Effect.mapError((error) => new PresetError({ message: String(error) })));
    if (!exists) return emptyFile.presets;
    const text = yield* fs
      .readFileString(path)
      .pipe(Effect.mapError((error) => new PresetError({ message: String(error) })));
    const json = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: (error) => new PresetError({ message: `Invalid preset JSON: ${String(error)}` }),
    });
    const decoded = yield* Schema.decodeUnknown(PresetFile)(json).pipe(
      Effect.mapError(
        (error) => new PresetError({ message: `Invalid preset file: ${String(error)}` }),
      ),
    );
    return decoded.presets;
  });

export const savePresets = (path: string, presets: ReadonlyArray<QueryPreset>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const clean = yield* Schema.decodeUnknown(PresetFile)({ version: 1, presets }).pipe(
      Effect.mapError((error) => new PresetError({ message: String(error) })),
    );
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (slash > 0)
      yield* fs
        .makeDirectory(path.slice(0, slash), { recursive: true })
        .pipe(Effect.mapError((error) => new PresetError({ message: String(error) })));
    yield* fs
      .writeFileString(path, JSON.stringify(clean, null, 2) + "\n", { mode: 0o600 })
      .pipe(Effect.mapError((error) => new PresetError({ message: String(error) })));
    return clean.presets;
  });

export const upsertPreset = (
  presets: ReadonlyArray<QueryPreset>,
  name: string,
  filters: FilterForm,
) => {
  const preset: QueryPreset = { name: name.trim(), filters: { ...filters } };
  return [...presets.filter((item) => item.name !== preset.name), preset].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
};

export const removePreset = (presets: ReadonlyArray<QueryPreset>, name: string) =>
  presets.filter((preset) => preset.name !== name);

export const defaultPresetPath = (env: Record<string, string | undefined> = process.env) => {
  if (env.PIHOLE_EXPORT_PRESETS?.trim()) return env.PIHOLE_EXPORT_PRESETS;
  const root = env.XDG_CONFIG_HOME ?? env.APPDATA ?? env.HOME ?? ".";
  return `${root.replace(/[\\/]$/, "")}/pihole-export/presets.json`;
};
