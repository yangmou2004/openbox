import json, os, struct, sys

SRC = r"e:\yangjia\Desktop\开箱记录\resources\app.asar"
OUT = r"e:\yangjia\Desktop\开箱记录\_audit_extracted"

with open(SRC, "rb") as f:
    data = f.read()

# asar header: 4 uint32 pickles
a, b, c, d = struct.unpack_from("<4I", data, 0)
json_size = d
header_json = data[16:16 + json_size]
header = json.loads(header_json.decode("utf-8"))
base = 8 + b  # offset where file payloads begin

print(f"pickles: {a} {b} {c} {d}")
print(f"json_size={json_size} base_offset={base} filesize={len(data)}")

def walk(node, path):
    for name, meta in node.get("files", {}).items():
        p = path + "/" + name
        if "files" in meta:
            walk(meta, p)
        else:
            size = meta.get("size", 0)
            offset = meta.get("offset")
            print(f"  {size:>9}  {p}  (offset={offset}, unpacked={meta.get('unpacked', False)})")
            if offset is None:
                continue
            dst = os.path.join(OUT, p.lstrip("/").replace("/", os.sep))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            start = base + int(offset)
            with open(dst, "wb") as g:
                g.write(data[start:start + size])

print("\n--- contents ---")
walk(header, "")
print("\nExtracted to", OUT)
