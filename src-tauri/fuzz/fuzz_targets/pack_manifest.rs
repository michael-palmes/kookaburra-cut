#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| kookaburra_cut_fuzz::pack_manifest(data));
