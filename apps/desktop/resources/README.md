# Scope icon

The Scope icon is an open window with a blue breeze on a pale sky-blue tile. The tile stays opaque on both light and dark backgrounds; the outer padding is transparent.

| File             | Use                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `icon.png`       | 1024px artwork for the Electron Dock, window icon, and repository README.                                                                  |
| `icon-small.png` | 1024px compact master without the circle, for 16px and 32px icons.                                                                         |
| `icon.icns`      | Mac icon archive with standard and Retina representations from 16px through 1024px. The two smallest logical sizes use the compact master. |

The desktop launch sets its Mac icon through [Electron's Dock API](https://www.electronjs.org/docs/latest/api/dock#dockseticonimage-macos). The local [packaging command](../../../tools/package-desktop.ts) includes `icon.icns` in `Scope.app`; checkout launches use `icon.png`.

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
