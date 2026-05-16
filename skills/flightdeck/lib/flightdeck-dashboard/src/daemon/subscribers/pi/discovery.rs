use std::path::PathBuf;

pub(super) fn resolve_bridge_bin() -> Option<PathBuf> {
    for key in ["FLIGHTDECK_PI_BRIDGE", "PI_BRIDGE_BIN"] {
        if let Some(path) = std::env::var_os(key).map(PathBuf::from) {
            if path.is_file() {
                return Some(path);
            }
        }
    }
    let output = std::process::Command::new("bash")
        .args(["-lc", "command -v pi-bridge"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!path.is_empty()).then(|| PathBuf::from(path))
}
