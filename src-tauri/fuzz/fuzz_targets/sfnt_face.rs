#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| kookaburra_cut_fuzz::sfnt_face(data));
