# Third-party notices

EZVault is original, clean-room code (MIT). It builds on the following
open-source projects, whose licenses are honored as noted.

| Project      | License    | Use in EZVault                    | Notes                                                              |
|--------------|------------|-----------------------------------|--------------------------------------------------------------------|
| libheif-js   | LGPL-3.0   | Browser-side HEIC decode (WASM)    | Used as a separate WASM artifact; never statically linked.         |
| libvips      | LGPL-2.1+  | Via `sharp` (server thumbnails)   | Dynamically linked prebuilds only; never statically built.         |

(Full dependency list with licenses is generated at build time by the
license-check script and appended here.)
