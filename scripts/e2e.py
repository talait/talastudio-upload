# End-to-end test of upload.talastudio.net exactly as the Windows app does it.
# Run: python3 scripts/e2e.py  (needs Pillow and curl; registers a test PC named "Test Claude E2E (hapus)" — revoke it afterwards)
import hashlib, io, json, random, sys, time, urllib.request, urllib.error
from PIL import Image, ImageDraw
B = 'https://upload.talastudio.net'
CODE = 'TEST-%03d' % random.randint(100, 899)
ok = fail = 0
def check(name, cond, info=''):
    global ok, fail
    ok, fail = (ok + 1, fail) if cond else (ok, fail + 1)
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{info}]' if info else ''))
def req(method, path, body=None, tok=None, raw=False, url=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url or B + path, data=data, method=method)
    if data is not None: r.add_header('content-type', 'application/json')
    if tok: r.add_header('Authorization', 'Bearer ' + tok)
    r.add_header('x-app-version', '0.1.0'); r.add_header('User-Agent', 'TalaStudioUpload/0.1.0')
    try:
        with urllib.request.urlopen(r, timeout=60) as res:
            b = res.read(); return res.status, (b if raw else (json.loads(b) if b else None)), res.headers
    except urllib.error.HTTPError as e:
        b = e.read(); 
        try: b = json.loads(b)
        except Exception: pass
        return e.code, b, e.headers
def png(label):
    im = Image.new('RGB', (1200, 800), (240, 236, 230)); d = ImageDraw.Draw(im)
    d.rectangle([400, 200, 800, 650], outline=(29, 27, 25), width=8)
    for i in range(300): d.point((random.randint(0, 1199), random.randint(0, 799)), fill=(random.randint(0, 255),) * 3)
    d.text((420, 690), label, fill=(29, 27, 25)); bio = io.BytesIO(); im.save(bio, 'PNG'); return bio.getvalue()
def put_drive(session, data, chunk=None):
    # one PUT like the app (no Content-Type); urllib adds a form Content-Type that Drive refuses, so use curl
    import subprocess, tempfile
    with tempfile.NamedTemporaryFile(delete=False) as t: t.write(data)
    out = subprocess.run(['curl', '-sS', '-X', 'PUT', session, '-H', f'Content-Range: bytes 0-{len(data)-1}/{len(data)}', '-H', 'Content-Type:',
                          '-A', 'TalaStudioUpload/0.1.0', '--data-binary', '@' + t.name, '-w', '\n%{http_code}'], capture_output=True, text=True).stdout
    body, code = out.rsplit('\n', 1)
    return int(code), json.loads(body) if body.strip().startswith('{') else {'raw': body[:200]}

s, b, _ = req('GET', '/', raw=True); check('server answers', s == 200, b.decode().strip())
s, b, _ = req('GET', '/api/feed'); check('feed without token is refused', s == 401, s)
s, reg, _ = req('POST', '/api/register', {'name': 'Test Claude E2E (hapus)', 'os': 'test'}); tok = reg.get('token'); check('register PC', s == 200 and tok, reg.get('device_id'))
s, me, _ = req('GET', '/api/me', tok=tok); check('me', s == 200 and me['name'].startswith('Test Claude'))
s, c, _ = req('GET', '/api/codes', tok=tok); check('item codes from catalogue', s == 200 and len(c['codes']) > 10, len(c['codes']))

f1 = png('' + CODE + ' v1 uji Claude'); sha1 = hashlib.sha256(f1).hexdigest()
s, st, _ = req('POST', '/api/uploads', {'name': '' + CODE + ' uji.png', 'size': len(f1), 'sha256': sha1, 'mime': 'image/png', 'code': CODE.lower(), 'kind': 'render', 'note': 'Uji otomatis v1'}, tok)
check('start upload v1 (Drive session)', s == 200 and st.get('session_url'), f"{st.get('stored_name')} v{st.get('version')}")
vid1 = st['version_id']
s, b, _ = req('POST', f'/api/uploads/{vid1}/progress', {'bytes': len(f1) // 2}, tok); check('progress report', s == 200 and b.get('ok'))
ds, df = put_drive(st['session_url'], f1); check('bytes to Google Drive', ds in (200, 201) and df.get('id'), df.get('name'))
s, done, _ = req('POST', f'/api/uploads/{vid1}/done', {'file_id': df['id']}, tok); check('finish v1', s == 200 and done.get('status') == 'done', done.get('name'))
s, dup, _ = req('POST', '/api/uploads', {'name': 'salinan.png', 'size': len(f1), 'sha256': sha1, 'mime': 'image/png', 'code': CODE, 'kind': 'render'}, tok)
check('same bytes refused as duplicate', s == 200 and dup.get('duplicate'), json.dumps(dup.get('duplicate')))

f2 = png('' + CODE + ' v2 uji Claude'); sha2 = hashlib.sha256(f2).hexdigest()
s, st2, _ = req('POST', '/api/uploads', {'name': 'meja TEST998 revisi.png', 'size': len(f2), 'sha256': sha2, 'mime': 'image/png', 'code': CODE, 'kind': 'render', 'note': 'Uji otomatis v2'}, tok)
check('revision becomes version 2', s == 200 and st2.get('version') == 2, st2.get('stored_name'))
ds, df2 = put_drive(st2['session_url'], f2)
s, done2, _ = req('POST', f'/api/uploads/{st2["version_id"]}/done', {'file_id': df2['id']}, tok); check('finish v2', s == 200 and done2.get('version') == 2)

s, body, h = req('GET', f'/api/versions/{vid1}/download', tok=tok, raw=True)
check('download v1 returns the same bytes', s == 200 and hashlib.sha256(body).hexdigest() == sha1, h.get('content-disposition'))
s, feed, _ = req('GET', '/api/feed', tok=tok)
it = next((i for i in feed['items'] if i['code'] == CODE), None)
vs = [(v['version'], v['status'], len(v['downloads'])) for v in it['versions']] if it else None
check('shared history shows both versions and the download', it and vs[0][0] == 2 and any(v[0] == 1 and v[2] == 1 for v in vs), vs)
time.sleep(3)
s, body, h = req('GET', f'/api/versions/{vid1}/preview', tok=tok, raw=True)
check('preview picture (Drive thumbnail; may lag a minute)', s in (200, 204), f'{s} {len(body) if body else 0} bytes')

f3 = png('' + CODE + ' batal'); 
s, st3, _ = req('POST', '/api/uploads', {'name': 'batal.png', 'size': len(f3), 'sha256': hashlib.sha256(f3).hexdigest(), 'mime': 'image/png', 'code': CODE, 'kind': 'render'}, tok)
s, b, _ = req('POST', f'/api/uploads/{st3["version_id"]}/fail', {'cancelled': True, 'reason': 'uji batal'}, tok); check('cancel an upload', s == 200)
s, feed, _ = req('GET', '/api/feed', tok=tok)
it = next(i for i in feed['items'] if i['code'] == CODE)
check('cancelled upload does not take a version number', all(v['version'] in (1, 2) for v in it['versions'] if v['status'] == 'done') and all(v['version'] is None for v in it['versions'] if v['status'] == 'cancelled'))
s, b, _ = req('POST', '/api/rename', {'name': 'Test Claude E2E renamed'}, tok); check('rename PC', s == 200 and b['name'].endswith('renamed'))
s, b, _ = req('GET', '/app/update?current=0.0.9', tok=tok); check('update offered to an older app', s == 200 and b and b['version'] == '0.1.0' and b['signature'], b and b['url'])
s, b, _ = req('GET', '/app/update?current=0.1.0', tok=tok); check('no update for the current app', s == 204, s)
s, body, h = req('GET', '/app/download/0.1.0', tok=tok, raw=True); check('installer download for a registered PC', s == 200 and len(body) > 1_000_000, f'{len(body)} bytes')
s, body, h = req('GET', '/app/download/0.1.0', raw=True); check('installer refused without a token', s == 401, s)
print(f'\n{ok} passed, {fail} failed'); json.dump({'device': reg['device_id'], 'files': [df['id'], df2['id']]}, open('/home/claude/e2e/last.json', 'w'))
