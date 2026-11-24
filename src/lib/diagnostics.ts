import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// Same platform convention as the shared Rust core. This performs no I/O.
export const logsDirectory = () => {
  const home = homedir();
  const root =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA
      : process.platform === "darwin"
        ? join(home, "Library/Logs")
        : process.env.XDG_STATE_HOME && isAbsolute(process.env.XDG_STATE_HOME)
          ? process.env.XDG_STATE_HOME
          : join(home, ".local/state");
  return root ? join(root, "pihole-export/logs") : "Unavailable: user state directory is not set";
};
