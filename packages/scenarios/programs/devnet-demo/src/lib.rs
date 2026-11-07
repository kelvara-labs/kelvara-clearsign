// Minimal executable deployed only on devnet. The scenario exercises the
// upgradeable loader's authority, so no instruction ABI or external crate is needed.
#[no_mangle]
pub extern "C" fn entrypoint(_input: *mut u8) -> u64 {
    0
}
