// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    std::panic::set_hook(Box::new(|info| {
        let log_dir = std::env::var("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("Sovereign Exocortex");
        let _ = std::fs::create_dir_all(&log_dir);
        let path = log_dir.join("panic.log");
        let msg = format!("PANIC: {}\n", info);
        let _ = std::fs::write(path, msg);
    }));
    app_lib::run();
}
