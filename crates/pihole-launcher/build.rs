fn main() {
    println!("cargo:rerun-if-env-changed=PIHOLE_FRONTEND_PAYLOAD");
    let destination =
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("frontend.bin");
    if let Some(source) = std::env::var_os("PIHOLE_FRONTEND_PAYLOAD") {
        println!(
            "cargo:rerun-if-changed={}",
            std::path::Path::new(&source).display()
        );
        std::fs::copy(source, destination).unwrap();
    } else {
        std::fs::write(destination, []).unwrap();
    }
}
