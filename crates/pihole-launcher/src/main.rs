#![forbid(unsafe_code)]
fn launch() -> Result<i32, Box<dyn std::error::Error>> {
    let executable = std::env::current_exe()?;
    let temporary = std::env::temp_dir();
    for path in [&executable, &temporary, &std::env::current_dir()?] {
        pihole_core::offline_local_path(path)?;
    }
    let payload = include_bytes!(concat!(env!("OUT_DIR"), "/frontend.bin"));
    if payload.is_empty() {
        return Err("Build the standalone launcher with its frontend payload".into());
    }
    let directory = tempfile::Builder::new()
        .prefix("pihole-frontend-")
        .tempdir_in(temporary)?;
    let frontend = directory.path().join("pihole-frontend.exe");
    std::fs::write(&frontend, payload)?;
    // The child owns cancellation; keep the parent alive to reap it and remove its private payload.
    ctrlc::set_handler(|| {})?;
    let status = std::process::Command::new(&frontend)
        .args(std::env::args_os().skip(1))
        .env("PIHOLE_NATIVE_WORKER_EXE", executable)
        .status()?;
    Ok(status.code().unwrap_or(1))
}
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--native-worker") {
        pihole_backend::run();
        return;
    }
    match launch() {
        Ok(code) => std::process::exit(code),
        Err(_) => {
            eprintln!(
                "Cannot start: use a local executable, working directory and TEMP on a verified local drive without reparse points"
            );
            std::process::exit(1);
        }
    }
}
