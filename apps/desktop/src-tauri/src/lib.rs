use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

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
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_local_config])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Create tray menu items
            let show_i = MenuItem::with_id(app, "show", "Show Living Brain", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Sovereign Exocortex", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let icon = app
                .default_window_icon()
                .cloned()
                .expect("default window icon missing");

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .icon(icon)
                .tooltip("Sovereign Exocortex — Living Brain Online")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
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
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hide the window instead of exiting to preserve background event orchestration
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
