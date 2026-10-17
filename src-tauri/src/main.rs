// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args_os().skip(1);
    // `edit …` and `check …` are the headless CLIs: they must return before anything Tauri or AppKit starts (no Dock icon).
    match args.next() {
        Some(first) if first == "edit" => {
            std::process::exit(kookaburra_cut_lib::cli::main(args.collect()))
        }
        Some(first) if first == "check" => {
            std::process::exit(kookaburra_cut_lib::cli::check::main(args.collect()))
        }
        _ => {}
    }
    kookaburra_cut_lib::run();
}
