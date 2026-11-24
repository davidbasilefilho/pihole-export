//! Small audited native boundary; no input file is opened before drive classification.
#![deny(unsafe_code)]
#[cfg(windows)]
pub fn local_path(path: &std::path::Path) -> Result<(), &'static str> {
    use std::os::windows::fs::MetadataExt;
    let value = path
        .to_str()
        .ok_or("Offline paths must be Unicode local drive paths")?;
    let b = value.as_bytes();
    if b.len() < 3
        || !b[0].is_ascii_alphabetic()
        || b[1] != b':'
        || b[2] != b'\\'
        || value[3..].contains([':', '/', '\0'])
        || value[3..]
            .split('\\')
            .any(|p| p == "." || p == ".." || p.ends_with([' ', '.']))
    {
        return Err(
            "Offline paths require absolute drive paths; UNC, device paths, streams and parent aliases are blocked",
        );
    }
    classify_drive(b[0])?;
    let mut part = std::path::PathBuf::from(&value[..3]);
    for name in value[3..].split('\\').filter(|p| !p.is_empty()) {
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err("Windows device names are not offline paths");
        }
        part.push(name);
        match std::fs::symlink_metadata(&part) {
            Ok(m) if m.file_attributes() & 0x400 != 0 => {
                return Err(
                    "Offline paths cannot contain reparse points, junctions or cloud placeholders",
                );
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot verify local offline path"),
        }
    }
    Ok(())
}
#[cfg(windows)]
#[allow(unsafe_code)]
fn classify_drive(letter: u8) -> Result<(), &'static str> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, QueryDosDeviceW};
    let drive = [u16::from(letter), u16::from(b':'), 0];
    let root = [u16::from(letter), u16::from(b':'), u16::from(b'\\'), 0];
    let mut target = [0u16; 4096];
    // SAFETY: fixed UTF-16 NUL-terminated input buffers and a correctly sized,
    // writable output buffer, all alive for these synchronous Win32 calls.
    let length =
        unsafe { QueryDosDeviceW(drive.as_ptr(), target.as_mut_ptr(), target.len() as u32) };
    if length == 0 {
        return Err("Cannot verify offline drive mapping");
    }
    let end = target.iter().position(|c| *c == 0).unwrap_or(target.len());
    let target = String::from_utf16_lossy(&target[..end]);
    // Reject SUBST, redirectors and unknown device aliases before path traversal.
    if !target.starts_with("\\Device\\HarddiskVolume")
        || !target[22..].chars().all(|c| c.is_ascii_digit())
        || target.len() <= 22
    {
        return Err(
            "Offline drive mapping is not a local disk volume; aliases and shared storage mappings are blocked",
        );
    }
    // Only ask about the volume after ruling out network/SUBST mappings.
    // SAFETY: root is a live NUL-terminated UTF-16 buffer.
    let kind = unsafe { GetDriveTypeW(root.as_ptr()) };
    if !matches!(kind, 2 | 3 | 6) {
        return Err("Offline paths require a verified local drive");
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::path::Path;
    #[test]
    fn rejects_nonlocal_and_ambiguous_paths_before_traversal() {
        for path in [
            r"\\localhost\never-open\snapshot.db",
            r"\\?\C:\snapshot.db",
            r"C:snapshot.db",
            r"C:\snapshot.db:stream",
            r"C:\a\..\snapshot.db",
            r"C:\NUL",
            r"C:\CONIN$",
            "C:/snapshot.db",
            "https://example.invalid/db",
        ] {
            assert!(local_path(Path::new(path)).is_err(), "{path}");
        }
    }
    #[test]
    fn accepts_verified_local_executable_and_temp() {
        local_path(&std::env::current_exe().unwrap()).unwrap();
        local_path(&std::env::temp_dir()).unwrap();
    }
}
