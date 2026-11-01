//! The render window's ranged flash check (`range` bridge requests): frames the export path renders at a check size come here one at a time and feed the flash detector the export tap uses; the report goes back in the response. Contract: docs/agent-kit.md (Ranged checks).

use std::sync::Mutex;

use serde_json::Value;
use tauri::State;

use crate::flashes::{FlashDetector, Standards};

const MAX_EDGE: u32 = 4096;

/// One ranged check in flight: the detector and the frame size it was armed for.
pub(crate) struct RangeSession {
    detector: FlashDetector,
    frame_len: usize,
}

impl RangeSession {
    pub(crate) fn new(
        width: u32,
        height: u32,
        fps: f64,
        standard: Option<&str>,
    ) -> Result<Self, String> {
        if width == 0 || height == 0 || width > MAX_EDGE || height > MAX_EDGE {
            return Err(format!("implausible check size {width}x{height}"));
        }
        if !(fps.is_finite() && fps > 0.0 && fps <= 240.0) {
            return Err(format!(
                "a ranged check needs a rate from 1 to 240 fps, not {fps}"
            ));
        }
        let standards = match standard {
            None => Standards::BOTH,
            Some(raw) => Standards::parse(raw)
                .ok_or_else(|| format!("standard takes wcag, itu or both, not {raw:?}"))?,
        };
        let mut detector = FlashDetector::new(width, height, fps, standards);
        detector.source = "range".to_owned();
        Ok(Self {
            detector,
            frame_len: width as usize * height as usize * 4,
        })
    }

    /// One GL readback (RGBA, rows bottom-up).
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() != self.frame_len {
            return Err(format!(
                "frame is {} bytes, expected {}",
                bytes.len(),
                self.frame_len
            ));
        }
        self.detector.push_rgba(bytes, true);
        Ok(())
    }

    pub(crate) fn finish(self) -> Result<Value, String> {
        serde_json::to_value(self.detector.finish()).map_err(|e| e.to_string())
    }
}

#[derive(Default)]
pub struct RangeFlashState(Mutex<Option<RangeSession>>);

#[tauri::command]
pub fn range_flash_begin(
    state: State<'_, RangeFlashState>,
    width: u32,
    height: u32,
    fps: f64,
    standard: Option<String>,
) -> Result<(), String> {
    let session = RangeSession::new(width, height, fps, standard.as_deref())?;
    *state.0.lock().map_err(|_| "ranged check state poisoned")? = Some(session);
    Ok(())
}

#[tauri::command]
pub fn range_flash_push(
    state: State<'_, RangeFlashState>,
    request: tauri::ipc::Request,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("range_flash_push expects a raw binary body".into());
    };
    let mut guard = state.0.lock().map_err(|_| "ranged check state poisoned")?;
    guard
        .as_mut()
        .ok_or("no ranged check armed (call range_flash_begin first)")?
        .push(bytes)
}

#[tauri::command]
pub fn range_flash_finish(state: State<'_, RangeFlashState>) -> Result<Value, String> {
    let session = state
        .0
        .lock()
        .map_err(|_| "ranged check state poisoned")?
        .take()
        .ok_or("no ranged check armed (call range_flash_begin first)")?;
    session.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(w: usize, h: usize, v: u8) -> Vec<u8> {
        let mut out = vec![v; w * h * 4];
        for px in out.chunks_mut(4) {
            px[3] = 255;
        }
        out
    }

    #[test]
    fn a_ranged_strobe_fails_and_reports_its_source() {
        let mut session = RangeSession::new(64, 36, 30.0, None).unwrap();
        for n in 0..60 {
            let v = if (n / 3) % 2 == 0 { 0 } else { 255 };
            session.push(&frame(64, 36, v)).unwrap();
        }
        let report = session.finish().unwrap();
        assert_eq!(report["ok"], false);
        assert_eq!(report["source"], "range");
        assert_eq!(report["frames"], 60);
    }

    #[test]
    fn bad_sizes_rates_and_frames_are_refused() {
        assert!(RangeSession::new(0, 36, 30.0, None).is_err());
        assert!(RangeSession::new(64, 36, 0.0, None).is_err());
        assert!(RangeSession::new(64, 36, 30.0, Some("ada")).is_err());
        let mut session = RangeSession::new(64, 36, 30.0, Some("wcag")).unwrap();
        assert!(session.push(&[0; 12]).is_err());
    }
}
