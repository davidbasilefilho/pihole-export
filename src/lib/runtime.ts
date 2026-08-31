import { FileSystem, HttpClient } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Layer, ManagedRuntime } from "effect";

import { HttpLive } from "./api";

export type AppServices = HttpClient.HttpClient | FileSystem.FileSystem;
export const runtime = ManagedRuntime.make(Layer.merge(HttpLive, BunFileSystem.layer));
