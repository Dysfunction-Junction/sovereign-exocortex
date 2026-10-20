// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("PANIC: {}\n", info);
        let _ = std::fs::write("C:\\Users\\micha\\AppData\\Local\\Sovereign Exocortex\\panic.log", msg);
    }));
    app_lib::run();
}
