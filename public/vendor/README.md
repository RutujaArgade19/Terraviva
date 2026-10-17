# Vendored SHA-256 dependency

`js-sha256.js` is the unchanged, unminified browser UMD build of
[`js-sha256` 1.0.0](https://github.com/emn178/js-sha256), by Chen, Yi-Cyuan.
It has no runtime dependencies. The accompanying MIT licence is preserved in
`js-sha256.LICENSE.txt`.

## Exact upstream provenance

- Upstream commit: `9a54fb31d4594762987e1b5d175265f6bac921de`.
- [Source build](https://github.com/emn178/js-sha256/blob/9a54fb31d4594762987e1b5d175265f6bac921de/build/sha256.js).
- [Licence](https://github.com/emn178/js-sha256/blob/9a54fb31d4594762987e1b5d175265f6bac921de/LICENSE.txt).
- Source size: 16,658 bytes.
- Source SHA-256: `d14e31deaf7b7c3a4a89035b32db12a6b7b92b1b91486fa58a8f107397639027`.
- Licence SHA-256: `2153bd2978793748fbe0eb8f838ae2ae19f03f9d4ee5473dd1628a0c0790e4ab`.
- Both files were checked against their upstream Git blob identities.

## Browser API

Load `/vendor/js-sha256.js` as an external script before the archive intake
script. It exposes the global `sha256` function. Use a separate incremental
instance for each file:

```js
const hash = sha256.create();
hash.update(chunk); // Uint8Array containing the original bytes
// Repeat update() for every chunk, in file order.
const checksum = hash.hex(); // 64 lowercase hexadecimal characters
```

Feed the original bytes directly. Text decoding would change the identity of
some sources. Hashing can read bounded Blob slices or a File stream; the
dependency does not require a whole-file ArrayBuffer. Do not call `update()`
after finalizing the hash.

## Verification

The browser UMD path was executed in an isolated JavaScript context without
Node module globals. Its results were compared with Node's `crypto` SHA-256:

- 45 incremental cases: five inputs, including empty input, standard text
  vectors, one million `a` bytes, and a binary subarray, each split at nine
  chunk sizes around SHA-256 block boundaries.
- Seven simulated padding-length cases around 512 MiB, 1 GiB, the archive's
  approximate size, and 4 GiB; the encoded 64-bit bit length matched BigInt
  calculations. The byte counter rollover was checked separately.
- An actual 1,073,741,841-byte stream, using a repeated 1 MiB binary chunk and
  a 17-byte tail, matched Node SHA-256:
  `ee0e9c462e333307a87b8b820cee996158c6d8de998e9513ce7ecd5d351d6ee0`.

These are synthetic implementation checks, not measurements of a user archive.
No rendered browser test or claim of a cryptographic audit is implied.
