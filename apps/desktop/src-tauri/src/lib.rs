use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

fn log_desktop(msg: &str) {
    let log_dir = std::env::var("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Sovereign Exocortex");
    let _ = std::fs::create_dir_all(&log_dir);
    let path = log_dir.join("desktop.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{:?}] {}", std::time::SystemTime::now(), msg);
    }
}

#[tauri::command]
fn get_local_config() -> Result<String, String> {
    let mut stream = TcpStream::connect("127.0.0.1:8788").map_err(|e| format!("Failed to connect to daemon: {}", e))?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
    let request = "GET /mobile/local-config HTTP/1.1\r\nHost: 127.0.0.1:8788\r\nAccept: application/json\r\nConnection: close\r\n\r\n";
    stream.write_all(request.as_bytes()).map_err(|e| format!("Write failed: {}", e))?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).map_err(|e| format!("Read failed: {}", e))?;
    let text = String::from_utf8_lossy(&response);
    if let Some(pos) = text.find("\r\n\r\n") {
        let body = &text[pos + 4..];
        Ok(body.to_string())
    } else {
        Err("Invalid HTTP response from local daemon".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log_desktop("Starting Tauri application runner");
    let builder = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_local_config])
        .setup(|app| {
            log_desktop("Inside setup callback");
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Register single-instance handler so secondary launches bring the window to front
            app.handle().plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                log_desktop("Single instance event: focusing main window");
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }))?;

            // Create tray menu items
            let show_i = MenuItem::with_id(app, "show", "Show Living Brain", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Sovereign Exocortex", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            if let Some(icon) = app.default_window_icon().cloned() {
                log_desktop("Building system tray with window icon");
                let _tray = TrayIconBuilder::new()
                    .menu(&menu)
                    .icon(icon)
                    .tooltip("Sovereign Exocortex — Living Brain Online")
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "quit" => {
                            log_desktop("Quit clicked from tray menu");
                            std::process::exit(0);
                        }
                        "show" => {
                            log_desktop("Show clicked from tray menu");
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            } else {
                log_desktop("Warning: default_window_icon returned None");
            }

            // Reveal and focus main window
            if let Some(window) = app.get_webview_window("main") {
                log_desktop("Revealing main window");
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            } else {
                log_desktop("Warning: could not find window 'main'");
            }

            log_desktop("Setup callback completed successfully");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                log_desktop("CloseRequested: hiding window to tray");
                let _ = window.hide();
                api.prevent_close();
            }
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                log_desktop("RunEvent::ExitRequested: staying alive in tray");
                api.prevent_exit();
            }
            tauri::RunEvent::WindowEvent { label, event, .. } => {
                log_desktop(&format!("WindowEvent {}: {:?}", label, event));
            }
            _ => {}
        }
    });
}
