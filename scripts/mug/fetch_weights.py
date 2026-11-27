#!/usr/bin/env python3
"""
Fetch only the MuG Diffusion weights (models/ckpt/model.ckpt + model.yaml) from the official
4.4 GB Windows bundle, using HTTP range requests: the zip's directory is read from the end of the
file and only the two members are downloaded.

    python fetch_weights.py OUT_DIR [--url URL] [--zip LOCAL_BUNDLE.zip]

MuG Diffusion: https://github.com/Keytoyze/Mug-Diffusion (code MIT; model weights and the charts
they create are non-commercial).
"""
import argparse
import io
import os
import sys
import urllib.request
import zipfile

GDRIVE_ID = "1-TmLsveLAjRCPwd0iwXS7V1v61MlQ7DM"
DEFAULT_URL = f"https://drive.usercontent.google.com/download?id={GDRIVE_ID}&export=download&confirm=t"
WANTED = ("models/ckpt/model.ckpt", "models/ckpt/model.yaml")


class HttpRangeFile(io.RawIOBase):
    """Read-only, seekable view of a remote file (needs HTTP Range support)."""

    def __init__(self, url: str):
        self.url = url
        self.pos = 0
        req = urllib.request.Request(url, headers={"Range": "bytes=0-0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            cr = r.headers.get("Content-Range")
            if not cr:
                raise RuntimeError("the server does not support range requests")
            self.size = int(cr.split("/")[-1])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        if n == 0 or self.pos >= self.size:
            return b""
        end = min(self.size, self.pos + n) - 1
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"})
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
        self.pos += len(data)
        return data

    def readinto(self, b):
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--zip", help="an already downloaded MugDiffusion.zip")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    src = open(a.zip, "rb") if a.zip else io.BufferedReader(HttpRangeFile(a.url), buffer_size=8 << 20)
    with zipfile.ZipFile(src) as z:
        names = {n.replace("\\", "/"): n for n in z.namelist()}
        for want in WANTED:
            match = next((orig for norm, orig in names.items() if norm.endswith(want)), None)
            if not match:
                sys.exit(f"{want} not found in the bundle")
            info = z.getinfo(match)
            dest = os.path.join(a.out, os.path.basename(want))
            print(f"{want}: {info.file_size / 1e6:.0f} MB -> {dest}", flush=True)
            with z.open(info) as fi, open(dest + ".part", "wb") as fo:
                done = 0
                while True:
                    chunk = fi.read(16 << 20)
                    if not chunk:
                        break
                    fo.write(chunk)
                    done += len(chunk)
                    print(f"  {done / max(1, info.file_size) * 100:5.1f}%", flush=True)
            os.replace(dest + ".part", dest)
    print("done")


if __name__ == "__main__":
    main()
