// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args_os().skip(1);
    // `edit …` is the headless CLI: it must return before anything Tauri or AppKit starts (no Dock icon).
    if args.next().is_some_and(|first| first == "edit") {
        std::process::exit(kookaburra_cut_lib::cli::main(args.collect()));
    }
    kookaburra_cut_lib::run();
}
