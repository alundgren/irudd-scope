# Third-party notices

Scope's shared desktop tokens derive theme values from Excalidraw's
[theme source](https://github.com/excalidraw/excalidraw/blob/afed9e6e27dd1cd5cc52857a405f7bea5312d813/packages/excalidraw/css/theme.scss).
The source is pinned to commit `afed9e6e27dd1cd5cc52857a405f7bea5312d813`.

The interface uses system fonts. The Excalidraw dependency supplies its editor
fonts, which the desktop build copies from the installed package. Keep the
package's font licenses with any redistributed desktop build.

## Excalidraw theme values

```text
MIT License

Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Tailcat

The `scope-tailcat` transport links Tailcat v0.7.0, copyright Tailscale Inc and
contributors, under the BSD 3-Clause License. The complete license is in
[TAILCAT-LICENSE](TAILCAT-LICENSE).

Each desktop build collects the Go standard library license and the
LICENSE, COPYING, NOTICE, copyright, and patent files supplied by the modules
linked into `scope-tailcat`. The packaged collection and its module versions
are in [the native transfer notices](../dist/transfer-licenses/NOTICE.md).

## QR codes

The renderer includes qrcode v1.5.4, copyright (c) 2012 Ryan Day, under the
MIT License. The complete license is in [QRCODE-LICENSE](QRCODE-LICENSE).
Its dijkstrajs dependency supplies path-finding functions, copyright (C) 2008
Wyatt Baldwin, under the MIT License. Its supplied notice is in
[DIJKSTRAJS-LICENSE.md](DIJKSTRAJS-LICENSE.md).
