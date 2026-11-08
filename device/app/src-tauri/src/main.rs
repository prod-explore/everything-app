// Tray-only app: no console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    everythingapp_device_lib::run()
}
