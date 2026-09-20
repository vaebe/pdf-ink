"""用 macOS Quick Look（CoreGraphics/PDFKit，与 PDF.js 完全独立）逐页渲染 PDF。

Quick Look 只渲染第一页，因此先把每页拆成单页文件再渲染。
用法：python render_pages.py <pdf> <outdir>
"""
import os
import subprocess
import sys

from pypdf import PdfReader, PdfWriter


def main() -> None:
    source = sys.argv[1]
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    reader = PdfReader(source)
    stem = os.path.splitext(os.path.basename(source))[0]

    for index in range(len(reader.pages)):
        writer = PdfWriter()
        writer.add_page(reader.pages[index])
        single = os.path.join(out_dir, f"{stem}-p{index + 1}.pdf")
        with open(single, "wb") as handle:
            writer.write(handle)

        subprocess.run(
            ["qlmanage", "-t", "-s", "900", "-o", out_dir, single],
            check=True,
            capture_output=True,
        )
    print(f"rendered {len(reader.pages)} page(s) into {out_dir}")


if __name__ == "__main__":
    main()
