# Third-party notices

EZVault is original, clean-room code (MIT). It builds on the following
open-source projects, whose licenses are honored as noted.

| Project      | License    | Use in EZVault                    | Notes                                                              |
|--------------|------------|-----------------------------------|--------------------------------------------------------------------|
| libheif-js   | LGPL-3.0   | Browser-side HEIC decode (WASM)    | Used as a separate WASM artifact; never statically linked.         |
| libvips      | LGPL-2.1+  | Via `sharp` (server thumbnails)   | Dynamically linked prebuilds only; never statically built.         |
| sql.js       | MIT        | Vendored WASM (`lib/import/vendor/sql-wasm.wasm`) for the .tpy wizard | Unmodified upstream artifact; source at github.com/sql-js/sql.js. |

(Full dependency list with licenses is generated at build time by the
license-check script and appended here.)
