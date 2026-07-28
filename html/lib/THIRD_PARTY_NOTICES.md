# Third-party notices

This project vendors the following JavaScript/CSS libraries directly under `html/lib/` rather than loading them from a CDN (see the README for why). All are used unmodified, straight from their official minified builds. None of their licenses require attribution in the running application — this file exists to preserve the required copyright/license notices in the repo, as their licenses require.

| File | Library | Version vendored | License | Upstream |
|---|---|---|---|---|
| `marked.min.js` | [Marked](https://marked.js.org/) | _fill in — see banner comment at top of file_ | MIT | https://github.com/markedjs/marked |
| `katex.min.js`, `katex.min.css` | [KaTeX](https://katex.org/) | _fill in_ | MIT | https://github.com/KaTeX/KaTeX |
| `jszip.min.js` | [JSZip](https://stuk.github.io/jszip/) | _fill in_ | MIT *(JSZip is dual-licensed MIT / GPLv3 — this project uses it under the MIT terms)* | https://github.com/Stuk/jszip |
| `pdf.min.js`, `pdf.worker.min.js` | [PDF.js](https://mozilla.github.io/pdf.js/) | _fill in_ | Apache License 2.0 | https://github.com/mozilla/pdf.js |

The frontend also uses **[Lucide](https://lucide.dev/)** icons (inline SVG, not a vendored JS bundle) — ISC License. https://github.com/lucide-icons/lucide

To fill in the version column: each minified file above normally retains a short license-banner comment near the top (`/*! marked vX.Y.Z ... */`, `/*! For license information please see ... */`, etc.) — open the file and check, or compare against a fresh download from the upstream project to confirm which release you have.

---

## MIT License

Applies to: Marked, KaTeX, JSZip (as used here).

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

- Marked — Copyright (c) 2018+, MarkedJS. Copyright (c) 2011-2018, Christopher Jeffrey.
- KaTeX — Copyright (c) 2013-2020 Khan Academy and other contributors.
- JSZip — Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso.

## Apache License 2.0

Applies to: PDF.js.

Copyright (c) Mozilla Foundation. Full license text: http://www.apache.org/licenses/LICENSE-2.0

Used unmodified — no changes to note under the license's "state changes" requirement.

## ISC License

Applies to: Lucide icons.

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide is held by Lucide Contributors.
