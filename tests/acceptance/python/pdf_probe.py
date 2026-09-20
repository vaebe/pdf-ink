"""独立核对工具：用 pypdf 解析 PDF 的页面几何、图片变换矩阵、注解与文本。

与应用的 PDF.js + pdf-lib 技术栈完全独立，用于给验收提供第三方证据。
用法：python inspect.py <pdf> [--out result.json]
"""
import json
import sys

from pypdf import PdfReader
from pypdf.generic import ContentStream


def multiply(m, n):
    """PDF 规范定义的矩阵相乘（m 之后叠加 n）。

    与 `cm` 运算符的语义一致：CTM_new = M_cm × CTM。
    """
    a1, b1, c1, d1, e1, f1 = m
    a2, b2, c2, d2, e2, f2 = n
    return [
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    ]


def content_stream(page, reader):
    raw = page.get_contents()
    if raw is None:
        return None
    try:
        return ContentStream(raw, reader)
    except TypeError:
        return ContentStream(raw, reader, None)


def image_objects(page, reader):
    stream = content_stream(page, reader)
    if stream is None:
        return []
    ctm = [1, 0, 0, 1, 0, 0]
    stack = []
    found = []
    for operands, operator in stream.operations:
        if operator == b"q":
            stack.append(list(ctm))
        elif operator == b"Q":
            ctm = stack.pop() if stack else [1, 0, 0, 1, 0, 0]
        elif operator == b"cm":
            ctm = multiply([float(value) for value in operands], ctm)
        elif operator == b"Do":
            name = operands[0]
            xobject = None
            try:
                xobject = page["/Resources"]["/XObject"][name]
            except Exception:
                xobject = None
            if xobject is None:
                continue
            xobject = xobject.get_object()
            if xobject.get("/Subtype") != "/Image":
                continue
            a, b, c, d, e, f = ctm
            # 单位正方形的四个角经累积矩阵变换后的落点，用于判断图片实际覆盖区域。
            corners = [
                [round(a * u + c * v + e, 6), round(b * u + d * v + f, 6)]
                for u, v in ((0, 0), (1, 0), (0, 1), (1, 1))
            ]
            found.append(
                {
                    "name": str(name),
                    "ctm": [round(value, 9) for value in ctm],
                    "determinant": round(a * d - b * c, 9),
                    "corners": corners,
                    "minCorner": [
                        min(point[0] for point in corners),
                        min(point[1] for point in corners),
                    ],
                    "maxCorner": [
                        max(point[0] for point in corners),
                        max(point[1] for point in corners),
                    ],
                    "pixelWidth": int(xobject.get("/Width", 0)),
                    "pixelHeight": int(xobject.get("/Height", 0)),
                }
            )
    return found


def annotations(page):
    result = []
    for entry in page.get("/Annots", []) or []:
        annot = entry.get_object()
        uri = None
        action = annot.get("/A")
        if action is not None:
            action = action.get_object()
            if action.get("/S") == "/URI":
                uri = str(action.get("/URI"))
        rect = annot.get("/Rect")
        result.append(
            {
                "subtype": str(annot.get("/Subtype")),
                "uri": uri,
                "rect": [round(float(v), 3) for v in rect] if rect else None,
            }
        )
    return result


def analyze(path):
    reader = PdfReader(path)
    pages = []
    for index, page in enumerate(reader.pages):
        cropbox = page.cropbox
        boxes = {
            "cropbox": [round(float(v), 3) for v in cropbox],
            "mediabox": [round(float(v), 3) for v in page.mediabox],
        }
        page_annots = annotations(page)
        text = page.extract_text() or ""
        pages.append(
            {
                "index": index,
                "rotate": int(page.get("/Rotate", 0) or 0),
                "boxes": boxes,
                "images": image_objects(page, reader),
                "annotations": page_annots,
                "text": text,
            }
        )
    return {"path": path, "pageCount": len(pages), "pages": pages}


if __name__ == "__main__":
    target = sys.argv[1]
    report = analyze(target)
    payload = json.dumps(report, ensure_ascii=False, indent=2)
    if "--out" in sys.argv:
        out_path = sys.argv[sys.argv.index("--out") + 1]
        with open(out_path, "w", encoding="utf-8") as handle:
            handle.write(payload)
        print(f"wrote {out_path}")
    else:
        print(payload)
