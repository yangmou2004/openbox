import struct, hashlib, sys, os

P = r"e:\yangjia\Desktop\开箱记录\开箱记录.exe"
size = os.path.getsize(P)
print(f"file size      : {size:,} bytes ({size/1048576:.2f} MB)")

f = open(P, "rb")
mz = f.read(2)
print(f"DOS magic      : {mz!r}")
f.seek(0x3C)
pe_off = struct.unpack("<I", f.read(4))[0]
f.seek(pe_off)
sig = f.read(4)
print(f"PE offset      : 0x{pe_off:x}   sig={sig!r}")
machine, nsec, _, _, _, optsize, chars = struct.unpack("<HHIIIHH", f.read(20))
print(f"machine        : 0x{machine:04x}  sections={nsec}  optHdrSize={optsize}")

# optional header
f.seek(pe_off + 24)
opt = f.read(optsize)
magic = struct.unpack_from("<H", opt, 0)[0]
print(f"opt magic      : 0x{magic:04x} ({'PE32+' if magic==0x20b else 'PE32'})")
ck_off = 64
stored_ck = struct.unpack_from("<I", opt, ck_off)[0]
print(f"stored checksum: 0x{stored_ck:08x}")

# section table
sec_off = pe_off + 24 + optsize
f.seek(sec_off)
secs = []
for i in range(nsec):
    raw = f.read(40)
    name = raw[:8].rstrip(b"\0").decode("latin1")
    vsize, vaddr, rsize, raddr = struct.unpack_from("<IIII", raw, 8)
    ch = struct.unpack_from("<I", raw, 36)[0]
    secs.append((name, vsize, vaddr, rsize, raddr, ch))
    print(f"  {name:<10} vaddr=0x{vaddr:08x} vsize=0x{vsize:08x} rawaddr=0x{raddr:08x} rawsize=0x{rsize:08x} flags=0x{ch:08x}")

end = max(raddr + rsize for _, _, _, rsize, raddr, _ in secs)
print(f"\nlast section end: 0x{end:x} ({end:,})")
overlay = size - end
print(f"OVERLAY          : {overlay:,} bytes")
if overlay > 0:
    f.seek(end)
    head = f.read(64)
    print(f"overlay head    : {head[:32]!r}")
    if head[:2] == b"MZ":
        print("  !! overlay is a PE executable (MZ) !!")
    elif head[:2] == b"PK":
        print("  !! overlay is a ZIP archive (PK) !!")
    else:
        print("  (overlay is not MZ/PK)")

f.close()

print("\nhashing...")
h = hashlib.sha256()
with open(P, "rb") as g:
    for chunk in iter(lambda: g.read(1 << 20), b""):
        h.update(chunk)
print(f"SHA256: {h.hexdigest()}")
