# Stage 6 A5: run both registered tests N times, report fingerprints. Read-only on the subject.
import os, sys, json, hashlib, platform, collections, tempfile
sys.path.insert(0, os.environ.get("MB_SRC", "src"))
from master_brain import ctp_runner as R
from master_brain.ctp_registry import builtin_registry
N = 30
out = {"python": platform.python_version(), "kernel": platform.release(), "uid": os.getuid(),
       "interp_sha256": hashlib.sha256(open(os.path.realpath(sys.executable), "rb").read()).hexdigest(),
       "kernel_limits": R.sandbox_status().get("kernel_limits"), "tests": {}}
for t in builtin_registry().all():
    c = collections.Counter()
    for _ in range(N):
        r = R.run_test(t.spec, case_id="a5", test_id=t.test_id, runner_id="a5")
        c[(r.outcome, r.exit_code, r.stdout_sha256[:16], r.stdout_bytes, r.outputs_sha256[:16], r.inputs_intact)] += 1
    out["tests"][t.test_id] = {"spec_digest": t.spec.digest()[:16], "distinct": len(c),
                               "runs": [[list(k), v] for k, v in c.items()]}
print(json.dumps(out, sort_keys=True))
