import { BunFileSystem } from "@effect/platform-bun";
import { FileSystem } from "effect";
import { Layer, ManagedRuntime } from "effect";
import { HttpClient } from "effect/http";

import { HttpLive } from "./api";

export type AppServices = HttpClient.HttpClient | FileSystem.FileSystem;
export const runtime = ManagedRuntime.make(Layer.merge(HttpLive, BunFileSystem.layer));
