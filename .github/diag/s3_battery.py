import os, sys, json, socket, threading, textwrap, time, uuid, subprocess, tempfile
sys.path.insert(0, os.environ.get("MB_SRC", "subject/src"))
from master_brain import ctp_runner as R
PY = R.sys.executable if hasattr(R, "sys") else sys.executable
PY = sys.executable
def mk(script, **kw):
    kw.setdefault("ro_paths", R.python_ro_paths()); kw.setdefault("criterion", "stage3 probe")
    return R.TestSpec(argv=(PY, "-I", "-c", textwrap.dedent(script)), **kw)
def run(label, script, **kw):
    t0 = time.time(); raw = R._run_raw(mk(script, **kw)); dt = time.time() - t0
    out = raw["stdout"].decode(errors="replace"); err = raw["stderr"].decode(errors="replace")
    print(f"=== {label}: outcome={raw['outcome']} exit={raw['exit_code']} sig={raw['term_signal']} wall={dt:.1f}s stdout={len(raw['stdout'])}B stderr={len(raw['stderr'])}B")
    print(out[:1500].rstrip()); 
    if err.strip(): print("[stderr]", err[:500].rstrip())
    return raw, out
print("sandbox_status:", json.dumps(R.sandbox_status(refresh=True), default=str)[:600])
marker = f"/tmp/ctp-host-marker-{uuid.uuid4().hex}"; open(marker, "w").write("HOST-SECRET")
host_sleeper = subprocess.Popen(["sleep", "300"]); 
srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(5); port = srv.getsockname()[1]
hits = []
threading.Thread(target=lambda: [hits.append(srv.accept()[1]) for _ in range(5)], daemon=True).start()

run("S1 pid isolation", f"""
import os
pids=[d for d in os.listdir('/proc') if d.isdigit()]
try: os.kill({host_sleeper.pid},0); host='REACHABLE'
except Exception as e: host=type(e).__name__
print({{'visible_pids':pids,'host_pid_signal':host}})
""", env=(("X","1"),))

run("S2 filesystem", f"""
import os
res={{}}
def w(p):
    try: open(p,'w').write('x'); return 'WRITTEN'
    except Exception as e: return type(e).__name__
for p in ['/x','/usr/x','/etc/x','/proc/sys/kernel/hostname','/work/ok','/tmp/ok']: res['w:'+p]=w(p)
def r(p):
    try: return 'READ:'+open(p).read()[:20]
    except Exception as e: return type(e).__name__
for p in ['{marker}','/root/.ccr/ca-bundle.crt','/etc/shadow']: res['r:'+p]=r(p)
for d in ['/home','/root','/home/claude']:
    try: res['ls:'+d]=os.listdir(d)[:5]
    except Exception as e: res['ls:'+d]=type(e).__name__
print(res)
""")

run("S3 network", f"""
import socket
print(open('/proc/net/dev').read().split('\\n')[2:])
for host,port in [('127.0.0.1',{port}),('1.1.1.1',53)]:
    s=socket.socket(); s.settimeout(2)
    try: s.connect((host,port)); print(host,'CONNECTED')
    except Exception as e: print(host,type(e).__name__,e)
""")
print("host listener accepted connections from sandbox:", len(hits))

run("S4 privileges", """
import os,ctypes
st=open('/proc/self/status').read()
print([l for l in st.split('\\n') if l.startswith(('Uid','CapEff','CapBnd','NoNewPrivs','Seccomp'))])
libc=ctypes.CDLL(None,use_errno=True)
print('unshare(CLONE_NEWUSER)=',libc.unshare(0x10000000),'errno',ctypes.get_errno())
print('unshare(CLONE_NEWNET)=',libc.unshare(0x40000000),'errno',ctypes.get_errno())
print('uid',os.getuid())
""")

run("S5a memory one process 600MB", "b=bytearray(600*1024*1024); print('ALLOCATED',len(b))")

raw, out = run("S5b memory aggregate 4x400MB", """
import os,time
r,w=os.pipe(); kids=[]
for i in range(4):
    pid=os.fork()
    if pid==0:
        try:
            b=bytearray(400*1024*1024)
            for j in range(0,len(b),4096): b[j]=1
            os.write(w,b'1'); time.sleep(1.5)
        except MemoryError: os.write(w,b'0')
        os._exit(0)
    kids.append(pid)
time.sleep(1.0)
os.close(w); got=b''
for pid in kids: os.waitpid(pid,0)
data=os.read(r,100)
print('children_allocated_400MB=',data.count(b'1'),'of 4')
""", timeout_s=15)

run("S5c fork count (bounded 1500)", """
import os,time,signal
kids=[]; err=None
for i in range(1500):
    try:
        pid=os.fork()
    except OSError as e:
        err=str(e); break
    if pid==0:
        time.sleep(4); os._exit(0)
    kids.append(pid)
print('children_created=',len(kids),'first_error=',err)
for p in kids:
    try: os.kill(p,signal.SIGKILL)
    except Exception: pass
for p in kids:
    try: os.waitpid(p,0)
    except Exception: pass
""", timeout_s=20)

run("S5d disk via /work (bounded 100MB)", """
import os
n=0; err=None; chunk=b'x'*65536
for i in range(1600):
    try:
        with open(f'/work/f{i}','wb') as f: f.write(chunk)
        n+=1
    except Exception as e: err=type(e).__name__; break
print('files_written=',n,'bytes=',n*65536,'stopped_by=',err)
""", timeout_s=20)

raw, out = run("S6 timeout + setsid child cleanup", """
import os,time
pid=os.fork()
if pid==0:
    os.setsid(); time.sleep(120); os._exit(0)
while True: pass
""", timeout_s=2)
time.sleep(1)
left = subprocess.run(["pgrep","-fc","time.sleep\\(120\\)"],capture_output=True,text=True).stdout.strip()
print("leftover host processes matching sandbox child:", left or "0")

raw, out = run("S7 output flood 200MB", """
import sys
chunk='A'*(1<<20)
for i in range(200): sys.stdout.write(chunk); sys.stdout.flush()
""", timeout_s=20)
print("--- cleanup"); host_sleeper.kill(); os.unlink(marker)
