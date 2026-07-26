//! `.kbpack` export and import: one file carrying projects, themes, fonts, objects, gradients, export presets and screenshots.
//!
//! Format spec in `docs/packs.md`. Two rules hold the whole module together: nothing outside `apply` writes into the
//! workspace, and a pack's payload is untrusted until every byte has been hashed against its signed manifest.

pub mod apply;
pub mod commands;
pub mod conflicts;
pub mod deps;
pub mod error;
pub mod fonts;
pub mod hash;
pub mod key;
pub mod limits;
pub mod model;
pub mod paths;
pub mod publisher;
pub mod read;
pub mod scan;
#[cfg(test)]
mod tests;
pub mod write;
