"""用 PDFium（Chromium 的 PDF 引擎，与应用的 PDF.js 技术栈独立）逐页渲染 PDF 为 PNG。

用法：python render_pdfium.py <pdf> <outdir> [scale]
"""
import os
import sys

import pypdfium2


def main() -> None:
    source = sys.argv[1]
    out_dir = sys.argv[2]
    scale = float(sys.argv[3]) if len(sys.argv) > 3 else 1.5
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(source))[0]

    document = pypdfium2.PdfDocument(source)
    for index in range(len(document)):
        page = document[index]
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil()
        target = os.path.join(out_dir, f"{stem}-p{index + 1}.png")
        image.save(target)
        print(f"{target}  {image.width}x{image.height}  page_rotate_hint={page.get_rotation()}")
    version = "unknown"
    for name in ("V_PDFIUM", "V_LIBPDFIUM"):
        version = getattr(pypdfium2, name, None) or getattr(pypdfium2.version, name, None) or version
    print(f"PDFium {version} — rendered {len(document)} page(s) into {out_dir}")


if __name__ == "__main__":
    main()
