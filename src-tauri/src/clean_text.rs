//! Text that leaves the app for an agent's context or a terminal (bridge responses) is escaped first: control and
//! format characters become visible `\uXXXX` escapes and one string is capped, so a crafted scene name can neither drive
//! a terminal (OSC 52, cursor moves) nor hide text behind bidi overrides or tag characters. `kblib/util.py` `clean_text`
//! is the same rule on the kb side.

use serde_json::Value;

/// Characters past which a single string is cut, with a marker saying how much was dropped.
pub const CAP: usize = 500;

/// Unicode `Cf` (format) ranges, bidi controls and tag characters included; `Cc` is `char::is_control`.
const FORMAT_RANGES: &[(u32, u32)] = &[
    (0x00AD, 0x00AD),
    (0x0600, 0x0605),
    (0x061C, 0x061C),
    (0x06DD, 0x06DD),
    (0x070F, 0x070F),
    (0x0890, 0x0891),
    (0x08E2, 0x08E2),
    (0x180E, 0x180E),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x2064),
    (0x2066, 0x206F),
    (0xFEFF, 0xFEFF),
    (0xFFF9, 0xFFFB),
    (0x110BD, 0x110BD),
    (0x110CD, 0x110CD),
    (0x13430, 0x1343F),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0001, 0xE0001),
    (0xE0020, 0xE007F),
];

/// A character that is escaped: every control except newline and tab, and every format character.
pub fn needs_escape(c: char) -> bool {
    if c == '\n' || c == '\t' {
        return false;
    }
    if c.is_control() {
        return true;
    }
    let code = c as u32;
    FORMAT_RANGES
        .iter()
        .any(|&(lo, hi)| (lo..=hi).contains(&code))
}

fn escape(c: char) -> String {
    let code = c as u32;
    if code <= 0xFFFF {
        format!("\\u{code:04X}")
    } else {
        format!("\\U{code:08X}")
    }
}

/// Escape controls and format characters, then cap at `cap` characters with a marker.
pub fn clean_text_with_cap(text: &str, cap: usize) -> String {
    let clean = if text.chars().any(needs_escape) {
        let mut out = String::with_capacity(text.len() + 8);
        for c in text.chars() {
            if needs_escape(c) {
                out.push_str(&escape(c));
            } else {
                out.push(c);
            }
        }
        out
    } else {
        text.to_owned()
    };
    let total = clean.chars().count();
    if total <= cap {
        return clean;
    }
    let kept: String = clean.chars().take(cap).collect();
    format!("{kept} …[+{} chars]", total - cap)
}

pub fn clean_text(text: &str) -> String {
    clean_text_with_cap(text, CAP)
}

/// Every string in a JSON value, keys included.
pub fn clean_value(value: &mut Value) {
    match value {
        Value::String(text) => {
            if text.chars().any(needs_escape) || text.chars().count() > CAP {
                *text = clean_text(text);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(clean_value),
        Value::Object(map) => {
            let dirty: Vec<String> = map
                .keys()
                .filter(|k| k.chars().any(needs_escape) || k.chars().count() > CAP)
                .cloned()
                .collect();
            for key in dirty {
                if let Some(inner) = map.remove(&key) {
                    map.insert(clean_text(&key), inner);
                }
            }
            map.values_mut().for_each(clean_value);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn controls_and_format_characters_become_visible_escapes() {
        assert_eq!(
            clean_text("Title\u{1b}]52;c;aGVsbG8=\u{7}end"),
            "Title\\u001B]52;c;aGVsbG8=\\u0007end"
        );
        assert_eq!(clean_text("a\u{202E}b\u{200B}c"), "a\\u202Eb\\u200Bc");
        assert_eq!(clean_text("tag\u{E0041}"), "tag\\U000E0041");
        assert_eq!(clean_text("keep\n\ttabs"), "keep\n\ttabs");
        assert_eq!(clean_text("plain ünïcödé 🎬"), "plain ünïcödé 🎬");
    }

    #[test]
    fn long_strings_are_capped_with_a_marker() {
        let long = "x".repeat(CAP + 25);
        let out = clean_text(&long);
        assert!(out.starts_with(&"x".repeat(CAP)));
        assert!(out.ends_with(" …[+25 chars]"));
        assert_eq!(clean_text(&"y".repeat(CAP)), "y".repeat(CAP));
    }

    #[test]
    fn json_strings_and_keys_are_cleaned_in_place() {
        let mut body = json!({
            "ok": true,
            "frames": [{ "scene": "01-\u{1b}[2Jhero", "at": 1.5 }],
            "na\u{200F}me": "x",
            "nested": { "list": ["a\u{9d}b"] }
        });
        clean_value(&mut body);
        assert_eq!(body["frames"][0]["scene"], "01-\\u001B[2Jhero");
        assert_eq!(body["frames"][0]["at"], 1.5);
        assert_eq!(body["na\\u200Fme"], "x");
        assert_eq!(body["nested"]["list"][0], "a\\u009Db");
    }
}
