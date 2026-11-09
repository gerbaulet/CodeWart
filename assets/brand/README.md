# CodeWart brand assets

The owl signet with `< >` eyes and a folded page: a sharp-eyed reviewer for AI-written code.

| Folder | Files | Use |
| --- | --- | --- |
| `app-icon/` | `codewart-icon.svg` (source), `codewart-icon-{16…1024}.png`, `codewart.icns`, `codewart.ico` | Flat app icon on the macOS grid (824 px tile on a 1024 px transparent canvas). `make icons` builds `src-tauri/icons` from the 1024 px PNG. |
| `signet/` | `signet-dark.*`, `signet-light.*`, `signet-mono.svg` | The owl on its own. **dark** for light backgrounds, **light** for dark backgrounds, **mono** uses `currentColor` with the eyes knocked out. |
| `wordmark/` | `wordmark-dark.*`, `wordmark-light.*`, `wordmark-mono.svg` | "CodeWart" type: **Code** bold, **wart** light. Letter counters are transparent. |
| `lockup/` | `codewart-lockup-dark.*`, `codewart-lockup-light.*` | Signet + wordmark side by side. |

SVG is the source; the PNGs are transparent renders of the SVGs.

## Colours

| Token | Hex | Where |
| --- | --- | --- |
| Ink | `#10151E` | signet and wordmark on light, app-icon tile |
| Paper | `#FFFFFF` | signet and wordmark on dark, eyes on light |
| Fold (on light) | `#CFD2DA` | folded page |
| Fold (on dark) | `#C4C8D1` | folded page |

In the app, `src/components/Icons.tsx` → `Logo` renders the mono signet from `src/components/signet.ts`, so it follows the theme's text colour, and the fold uses `--logo-fold`.

## Origin

Generated with OpenAI gpt-image-2.5 (`openai/gpt-image-2.5-sunburst` on Replicate) and vectorised with `recraft-ai/recraft-vectorize`. The raw generations are in `assets/generated/` (not committed).
