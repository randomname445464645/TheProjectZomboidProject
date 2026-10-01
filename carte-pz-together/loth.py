import struct
def parse(p):
    d=open(p,'rb').read(); o=0
    assert d[:4]==b'LOTH'
    ver=struct.unpack_from('<i',d,4)[0]
    n=struct.unpack_from('<i',d,8)[0]; o=12
    tiles=[]
    for _ in range(n):
        e=d.index(b'\n',o); tiles.append(d[o:e].decode('utf8','replace')); o=e+1
    def i4():
        nonlocal o
        v=struct.unpack_from('<i',d,o)[0]; o+=4; return v
    w=i4(); h=i4(); lmin=i4(); lmax=i4(); nroom=i4()
    rooms=[]
    for _ in range(nroom):
        e=d.index(b'\n',o); name=d[o:e].decode('utf8','replace'); o=e+1
        layer=i4(); nrect=i4(); rects=[]
        for _ in range(nrect):
            rects.append((i4(),i4(),i4(),i4()))
        nobj=i4(); objs=[]
        for _ in range(nobj):
            objs.append((i4(),i4(),i4()))
        rooms.append((name,layer,rects,objs))
    return dict(ver=ver,tiles=tiles,w=w,h=h,lmin=lmin,lmax=lmax,rooms=rooms,off=o,size=len(d))
