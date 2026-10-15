# Third-party notices

EZVault is original, clean-room code (MIT). It builds on the following
open-source projects, whose licenses are honored as noted.

| Project      | License    | Use in EZVault                    | Notes                                                              |
|--------------|------------|-----------------------------------|--------------------------------------------------------------------|
| libheif-js   | LGPL-3.0   | Browser-side HEIC decode (WASM)    | Used as a separate WASM artifact; never statically linked. License text: https://www.gnu.org/licenses/lgpl-3.0.html · codec source: https://github.com/strukturag/libheif/blob/master/COPYING |
| libvips      | LGPL-2.1+  | Via `sharp` (server thumbnails)   | Dynamically linked prebuilds only; never statically built. License text: https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html · source: https://github.com/libvips/libvips/blob/master/LICENSE |
| sql.js       | MIT        | Vendored WASM (`lib/import/vendor/sql-wasm.wasm`) for the .tpy wizard | Unmodified upstream artifact; source at github.com/sql-js/sql.js. |

The build enforces the license policy at build time (`scripts/check-licences.mjs`
fails the build if any GPL/AGPL/SSPL-licensed code is vendored); the table above
is the curated list of copyleft-adjacent dependencies with their compliance notes.
