# Makes the scanned-PDF fixtures in tests/fixtures/office: pages that are pictures with no text layer, in the three
# compressions scanners use. Atelier turns such pages into images for the model (public/app.js pdfShots), and pdf.js needs
# its wasm decoders for two of them (v114: without those, the pages rendered blank).
#   scan-ccitt.pdf  black-and-white fax compression (CCITT Group 4), what office scanners and copiers write
#   scan-jpx.pdf    JPEG 2000
#   scan-jpeg.pdf   plain JPEG, what phone scanner apps write (needs no wasm)
# Needs Pillow with libtiff and OpenJPEG:  python scripts/make-scan-fixtures.py
import io
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tests', 'fixtures', 'office')
W, H = 850, 1100  # a US Letter page at 100 dpi


def page(n, total, label, mode):
    im = Image.new('L', (W, H), 255)
    d = ImageDraw.Draw(im)
    try:
        big, small = ImageFont.truetype('arial.ttf', 44), ImageFont.truetype('arial.ttf', 26)
    except OSError:
        big = small = ImageFont.load_default()
    d.text((70, 90), f'SCANNED PAGE {n} OF {total}', fill=0, font=big)
    d.text((70, 170), f'Compression: {label}', fill=0, font=small)
    d.text((70, 230), f'Invoice 20{n}7 total due: ${n},250.00', fill=0, font=small)
    d.rectangle((70, 320, W - 70, 330), fill=0)
    for i in range(8):
        d.text((70, 370 + i * 44), f'Line {i + 1} of page {n}: the quick brown fox jumps over the lazy dog.', fill=0, font=small)
    return im.convert('1') if mode == '1' else im


def image_object(im, kind):
    if kind == 'ccitt':
        buf = io.BytesIO()
        im.save(buf, format='TIFF', compression='group4', tiffinfo={278: im.height})  # one strip: the whole page
        buf.seek(0)
        tif = Image.open(buf)
        offsets, counts = tif.tag_v2[273], tif.tag_v2[279]
        assert len(offsets) == 1, 'expected a single strip'
        data = buf.getvalue()[offsets[0]:offsets[0] + counts[0]]
        black_is_1 = 'true' if tif.tag_v2.get(262, 0) == 1 else 'false'  # PhotometricInterpretation 1: zero is black
        head = (f'<< /Type /XObject /Subtype /Image /Width {im.width} /Height {im.height} /ColorSpace /DeviceGray /BitsPerComponent 1 '
                f'/Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns {im.width} /Rows {im.height} /BlackIs1 {black_is_1} >> /Length {len(data)} >>')
    elif kind == 'jpx':
        buf = io.BytesIO()
        im.save(buf, format='JPEG2000', quality_mode='rates', quality_layers=[20])
        data = buf.getvalue()
        head = f'<< /Type /XObject /Subtype /Image /Width {im.width} /Height {im.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /JPXDecode /Length {len(data)} >>'
    else:
        buf = io.BytesIO()
        im.save(buf, format='JPEG', quality=60)
        data = buf.getvalue()
        head = f'<< /Type /XObject /Subtype /Image /Width {im.width} /Height {im.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length {len(data)} >>'
    return head.encode('ascii') + b'\nstream\n' + data + b'\nendstream'


def pdf(path, images):
    objs = [None, None]  # 1 catalog, 2 pages
    kids = []
    for body in images:
        img = len(objs) + 1
        content = b'q 612 0 0 792 0 0 cm /Im0 Do Q'
        objs.append(body)
        objs.append(b'<< /Length %d >>\nstream\n' % len(content) + content + b'\nendstream')
        objs.append(b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 %d 0 R >> >> /Contents %d 0 R >>' % (img, img + 1))
        kids.append(img + 2)
    objs[0] = b'<< /Type /Catalog /Pages 2 0 R >>'
    objs[1] = b'<< /Type /Pages /Kids [' + b' '.join(b'%d 0 R' % k for k in kids) + b'] /Count %d >>' % len(kids)
    out = bytearray(b'%PDF-1.5\n%\xe2\xe3\xcf\xd3\n')
    offsets = []
    for i, body in enumerate(objs):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % (i + 1) + body + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1)
    for o in offsets:
        out += b'%010d 00000 n \n' % o
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, xref)
    with open(path, 'wb') as f:
        f.write(out)
    print(os.path.basename(path), len(out), 'bytes,', len(images), 'pages')


os.makedirs(OUT, exist_ok=True)
pdf(os.path.join(OUT, 'scan-ccitt.pdf'), [image_object(page(n, 6, 'CCITT Group 4 fax', '1'), 'ccitt') for n in range(1, 7)])
pdf(os.path.join(OUT, 'scan-jpx.pdf'), [image_object(page(n, 2, 'JPEG 2000', 'L'), 'jpx') for n in range(1, 3)])
pdf(os.path.join(OUT, 'scan-jpeg.pdf'), [image_object(page(n, 2, 'JPEG', 'L'), 'jpeg') for n in range(1, 3)])
