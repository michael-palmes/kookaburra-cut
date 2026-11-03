#!/usr/bin/env node
// Checks an updater .sig the way the app does: minisign over the file's BLAKE2b hash, then the signed comment, against the base64 public key from plugins.updater.pubkey.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TRUSTED_PREFIX = "trusted comment: ";

const boxLines = (box) => Buffer.from(box.trim(), "base64").toString("utf8").split("\n");

/** Throws unless `sigBox` is `data` signed by `pubkeyBox`, with `version:<version>` in the signed comment. */
export function verifyUpdaterSig(data, sigBox, pubkeyBox, version) {
  const pub = Buffer.from(boxLines(pubkeyBox)[1] ?? "", "base64");
  if (pub.length !== 42 || pub.subarray(0, 2).toString() !== "Ed") {
    throw new Error("the updater public key is not a minisign Ed25519 key");
  }
  const [, sigLine = "", comment = "", globalLine = ""] = boxLines(sigBox);
  const sig = Buffer.from(sigLine, "base64");
  if (sig.length !== 74 || sig.subarray(0, 2).toString() !== "ED") {
    throw new Error("the updater signature is not a prehashed minisign signature");
  }
  if (!sig.subarray(2, 10).equals(pub.subarray(2, 10))) {
    throw new Error("the updater signature comes from a different key than plugins.updater.pubkey");
  }
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, pub.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const signature = sig.subarray(10);
  const digest = createHash("blake2b512").update(data).digest();
  if (!verify(null, digest, key, signature)) {
    throw new Error("the updater signature does not match the archive");
  }
  if (!comment.startsWith(TRUSTED_PREFIX))
    throw new Error("the updater signature has no trusted comment");
  const trusted = comment.slice(TRUSTED_PREFIX.length);
  const signed = Buffer.concat([signature, Buffer.from(trusted, "utf8")]);
  if (!verify(null, signed, key, Buffer.from(globalLine, "base64"))) {
    throw new Error("the updater signature's trusted comment is not signed");
  }
  if (!trusted.split("\t").includes(`version:${version}`)) {
    throw new Error(`the updater signature is not bound to version ${version}`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, sigFile, pubkey, version] = process.argv.slice(2);
  if (!file || !sigFile || !pubkey || !version) {
    console.error(
      "usage: verify-updater-sig.mjs <archive> <archive.sig> <base64 pubkey> <version>",
    );
    process.exit(2);
  }
  try {
    verifyUpdaterSig(readFileSync(file), readFileSync(sigFile, "utf8"), pubkey, version);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}
