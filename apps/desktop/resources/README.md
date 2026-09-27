# Scope icon

The Breath of fresh air icon is an open window with a blue breeze on a pale sky-blue tile. The tile stays opaque on both light and dark backgrounds; the outer padding is transparent.

| File             | Use                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `icon.png`       | 1024px artwork for the Electron Dock, window icon, and repository README.                                                                  |
| `icon-small.png` | 1024px compact master without the circle, for 16px and 32px icons and a future favicon.                                                    |
| `icon.icns`      | Mac icon archive with standard and Retina representations from 16px through 1024px. The two smallest logical sizes use the compact master. |

The current desktop launch sets its Mac icon through [Electron's Dock API](https://www.electronjs.org/docs/latest/api/dock#dockseticonimage-macos). The `.icns` file is available for a future application bundle; this repository does not yet package a Mac bundle.

## Export the Mac archive

Run from the repository root on macOS. The PNG files are the masters.

```sh
mkdir -p .scope-dev/Scope.iconset
for scope_icon_size in 16 32 128 256 512; do
  scope_icon_source=apps/desktop/resources/icon.png
  if [ "$scope_icon_size" -le 32 ]; then
    scope_icon_source=apps/desktop/resources/icon-small.png
  fi
  sips -z "$scope_icon_size" "$scope_icon_size" "$scope_icon_source" \
    --out ".scope-dev/Scope.iconset/icon_${scope_icon_size}x${scope_icon_size}.png"
  scope_icon_retina=$((scope_icon_size * 2))
  sips -z "$scope_icon_retina" "$scope_icon_retina" "$scope_icon_source" \
    --out ".scope-dev/Scope.iconset/icon_${scope_icon_size}x${scope_icon_size}@2x.png"
done
iconutil -c icns .scope-dev/Scope.iconset -o apps/desktop/resources/icon.icns
```

## Artwork prompts

The artwork uses the built-in image generation tool. Its reference is the approved Breath of fresh air concept, a pale blue tile containing two open window panels, a blue breeze, and a blue circle. Export the resulting square images at 1024px with their alpha channels intact.

### App icon

```text
Use case: logo-brand.
Input image 1 is a reference contact sheet. The selected design is ONLY row 06, "Breath of fresh air / Air window", specifically its large app icon. Extract and refine that selected design as ONE finished application icon for Scope.
Preserve the selected icon's identity and layout: a pale sky-blue softly rounded square tile, two open charcoal window panels, one sky-blue circle above the centre, and one blue breeze curve flowing horizontally through the window. The left panel slopes inward at its top and bottom; the right panel mirrors it. The panels have intentional gaps where the breeze passes. Preserve the reference's slight hand-drawn irregularity, rounded stroke ends, gentle proportions and ample empty space.
Output: one square 1024 by 1024 PNG icon. Transparent only OUTSIDE the rounded tile. The tile itself is fully opaque very pale sky blue, about #DFEFF8, with a very subtle blue-grey outer edge. Charcoal window strokes about #27313A, breeze and circle about #579DD0. Tile centred, occupying about 86 percent of the canvas width and height so it has suitable breathing room as a Mac Dock icon. Centre the inner artwork within it and make it large enough to read at Dock size. Simple flat colour, no dramatic gradients, no glossy effects, no floating mockup, no extra texture.
Do not include the contact sheet, other icons, labels, text, watermarks, borders outside the tile, checkerboard, or a page background. No new motifs. Deliver just the complete selected icon on actual transparent outer padding.
```

### Compact icon

```text
Use case: logo-brand.
Input image 1 is a reference contact sheet. Use ONLY row 06, "Breath of fresh air / Air window". Create one compact version of its app icon for a future favicon and the smallest Mac icon sizes.
Preserve the pale sky-blue rounded tile, charcoal open window panels and single flowing blue breeze curve. Preserve the reference's window proportions and gently hand-drawn line quality. Omit the blue circle above the breeze. Use slightly thicker clean strokes and generous gaps so the two window panels and the wind remain distinct at 16 and 32 pixels. Reduce to exactly the two dark open panels and the one blue curve. Do not add detail or extra windows.
Output: one square 1024 by 1024 PNG master. Transparent only OUTSIDE the rounded tile. Fully opaque pale sky-blue tile about #DFEFF8, occupying 86 percent of the canvas width and height, centred, with a subtle blue-grey edge. Charcoal window strokes about #27313A and breeze about #579DD0. Flat colour, confident rounded strokes, no grain, no gradients, no glossy rendering. The compact mark must still look like the approved row 06 icon, just without the circle and with stronger strokes.
Do not include any other row, contact sheet, labels, text, other icons, watermarks, checkerboard, or opaque background outside the tile. One finished compact app icon only.
```
