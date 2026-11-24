// Standalone native GUI payload launcher. Built by package.py, not a Cargo package.
use std::{env, fs, io, os::unix::fs::{DirBuilderExt, PermissionsExt}, process::Command, time::{SystemTime, UNIX_EPOCH}};
include!("payload.rs");
struct Cleanup(std::path::PathBuf);
impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn run() -> io::Result<i32> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let path = env::temp_dir().join(format!("pihole-gui-{}-{stamp}", std::process::id()));
    fs::DirBuilder::new().mode(0o700).create(&path)?; // atomic, rejects preexisting paths
    let cleanup = Cleanup(path);
    for (name, bytes) in PAYLOAD {
        let dest = cleanup.0.join(name);
        if let Some(parent) = dest.parent() { fs::create_dir_all(parent)?; }
        fs::write(&dest, bytes)?;
        if *name == "pihole-desktop" { fs::set_permissions(&dest, fs::Permissions::from_mode(0o700))?; }
    }
    let status = Command::new(cleanup.0.join("pihole-desktop"))
        .args(env::args_os().skip(1))
        .env("LD_LIBRARY_PATH", cleanup.0.join("lib"))
        .status()?;
    Ok(status.code().unwrap_or(1))
}
fn main() { match run() { Ok(code) => std::process::exit(code), Err(e) => { eprintln!("GUI startup: {e}"); std::process::exit(1); } } }
