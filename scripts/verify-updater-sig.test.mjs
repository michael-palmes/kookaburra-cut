import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { describe, test } from "node:test";
import { verifyUpdaterSig } from "./verify-updater-sig.mjs";

const b64 = (b) => Buffer.from(b).toString("base64");

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const id = randomBytes(8);
  const line = b64(Buffer.concat([Buffer.from("Ed"), id, raw]));
  return { privateKey, id, box: b64(`untrusted comment: minisign public key\n${line}\n`) };
}

function makeSig(key, data, trusted, { alg = "ED", id = key.id } = {}) {
  const signature = sign(null, createHash("blake2b512").update(data).digest(), key.privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), key.privateKey);
  const line = b64(Buffer.concat([Buffer.from(alg), id, signature]));
  return b64(
    `untrusted comment: signature\n${line}\ntrusted comment: ${trusted}\n${b64(global)}\n`,
  );
}

const data = Buffer.from("the updater archive");
const trusted = "timestamp:1\tfile:app.tar.gz\tversion:1.2.3";

describe("verifyUpdaterSig", () => {
  const key = makeKey();

  test("accepts the archive signed by the configured key", () => {
    verifyUpdaterSig(data, makeSig(key, data, trusted), key.box, "1.2.3");
  });

  test("refuses a signature from another key", () => {
    assert.throws(
      () => verifyUpdaterSig(data, makeSig(makeKey(), data, trusted), key.box, "1.2.3"),
      /different key/,
    );
  });

  test("refuses another key claiming the configured key's id", () => {
    const other = { ...makeKey(), id: key.id };
    assert.throws(
      () => verifyUpdaterSig(data, makeSig(other, data, trusted), key.box, "1.2.3"),
      /does not match the archive/,
    );
  });

  test("refuses a changed archive", () => {
    assert.throws(
      () => verifyUpdaterSig(Buffer.from("x"), makeSig(key, data, trusted), key.box, "1.2.3"),
      /does not match the archive/,
    );
  });

  test("refuses an edited trusted comment", () => {
    const lines = Buffer.from(makeSig(key, data, trusted), "base64")
      .toString()
      .split("\n");
    lines[2] = lines[2].replace("version:1.2.3", "version:9.9.9");
    assert.throws(
      () => verifyUpdaterSig(data, b64(lines.join("\n")), key.box, "9.9.9"),
      /not signed/,
    );
  });

  test("refuses a signature bound to another version", () => {
    assert.throws(
      () => verifyUpdaterSig(data, makeSig(key, data, trusted), key.box, "1.2.4"),
      /not bound to version 1\.2\.4/,
    );
  });

  test("refuses a legacy unhashed signature and a malformed key", () => {
    assert.throws(
      () => verifyUpdaterSig(data, makeSig(key, data, trusted, { alg: "Ed" }), key.box, "1.2.3"),
      /not a prehashed/,
    );
    assert.throws(
      () => verifyUpdaterSig(data, makeSig(key, data, trusted), b64("nope"), "1.2.3"),
      /not a minisign/,
    );
  });
});
