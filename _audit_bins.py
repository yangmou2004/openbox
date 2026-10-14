import struct, os, glob

ROOT = r"e:\yangjia\Desktop\开箱记录"

def scan(p):
    size = os.path.getsize(p)
    with open(p, "rb") as f:
        if f.read(2) != b"MZ":
            return f"{os.path.basename(p):<28} not a PE (raw data)"
        f.seek(0x3C)
        pe = struct.unpack("<I", f.read(4))[0]
        f.seek(pe)
        if f.read(4) != b"PE\0\0":
            return f"{os.path.basename(p):<28} bad PE sig"
        machine, nsec, _, _, _, optsize, _ = struct.unpack("<HHIIIHH", f.read(20))
        sec_off = pe + 24 + optsize
        f.seek(sec_off)
        names, end = [], 0
        for _ in range(nsec):
            raw = f.read(40)
            nm = raw[:8].rstrip(b"\0").decode("latin1")
            _, _, rsize, raddr = struct.unpack_from("<IIII", raw, 8)
            names.append(nm)
            end = max(end, raddr + rsize)
    ov = size - end
    flag = "  <<< OVERLAY!" if ov > 0 else ""
    odd = [n for n in names if n not in (
        ".text", ".rdata", ".data", ".pdata", ".rsrc", ".reloc", ".tls",
        ".eh_fram", ".fptable", ".rodata", ".bss", ".idata", ".edata",
        "CPADinfo", "LZMADEC", "_RDATA", "malloc_h", "prot", ".didat",
        ".00cfg", ".sdata", ".gfids", ".giats", ".rdata$zzz", ".xdata")]
    return (f"{os.path.basename(p):<28} {size/1048576:8.2f} MB  secs={nsec:2d}  "
            f"overlay={ov:<8,}{flag}"
            + (f"  odd={odd}" if odd else ""))

print("=== PE binaries in app folder ===")
for p in sorted(glob.glob(os.path.join(ROOT, "*.exe")) + glob.glob(os.path.join(ROOT, "*.dll"))):
    print(scan(p))

print("\n=== dangling / unexpected ===")
allf = []
for dp, dn, fn in os.walk(ROOT):
    if "_audit_extracted" in dp:
        continue
    for n in fn:
        allf.append(os.path.join(dp, n))
print(f"total files (excl. audit dir): {len(allf)}")
exts = {}
for p in allf:
    e = os.path.splitext(p)[1].lower() or "(none)"
    exts[e] = exts.get(e, 0) + 1
for e, c in sorted(exts.items(), key=lambda kv: -kv[1]):
    print(f"  {e:<12} {c}")
