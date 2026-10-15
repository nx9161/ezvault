-- 0005_compressed_sha256.sql — audit round 3 (code-review medium).
--
-- The /storage/compress route recompresses originals to WebP to save bytes.
-- It used to OVERWRITE photos.checksum_sha256 with the COMPRESSED hash,
-- which broke upload dedupe: re-uploading the original later missed the
-- dedupe index (sha256 -> photo) and stored a duplicate. checksum_sha256
-- is the upload-dedupe identity and must keep referring to the ORIGINAL
-- bytes; the hash of the stored (possibly compressed) bytes lives here.
-- NULL = never compressed (or compressed before this migration).

ALTER TABLE photos ADD COLUMN compressed_sha256 TEXT;
