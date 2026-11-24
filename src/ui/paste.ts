import { createHostClipboard, type HostClipboardService } from "@opentui/core";

// Only a deliberate paste key reads the clipboard. Terminal paste wins over a
// pending host read; the input itself owns selection replacement and caret movement.
export function secretPaste(read?: (signal: AbortSignal) => Promise<string | undefined>) {
  let host: HostClipboardService | undefined;
  let pending: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    pending?.abort();
    pending = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    cancel,
    request(insert: (text: string) => void, focused: () => boolean) {
      cancel();
      const controller = new AbortController();
      pending = controller;
      timer = setTimeout(async () => {
        try {
          let text: string | undefined;
          if (read) text = await read(controller.signal);
          else {
            host ??= createHostClipboard({ timeoutMs: 1000, maxReadBytes: 65536 });
            const result = await host.read({
              preferredTypes: ["text/plain"],
              signal: controller.signal,
            });
            if (result.status === "read")
              text = new TextDecoder().decode(result.representation.bytes);
          }
          if (!controller.signal.aborted && focused() && text !== undefined) insert(text);
        } catch {
          /* Clipboard unavailable: terminal bracketed paste remains available. */
        }
      }, 40);
    },
    dispose() {
      cancel();
      void host?.dispose();
    },
  };
}
